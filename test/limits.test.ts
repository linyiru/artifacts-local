import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { MAX_BLOB_BYTES } from "../src/store.ts";
import { randomBytes } from "node:crypto";
import { handleBinding } from "../src/binding-rpc.ts";
import { createArtifactsBinding } from "../src/client.ts";
import { type RunningServer, classify, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

let tmp: Awaited<ReturnType<typeof tempDir>>;

beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

const bearer = (t: string) => ["-c", `http.extraHeader=Authorization: Bearer ${t}`];

describe("per-file size limit", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ dataDir: join(tmp.path, "limit"), maxBlobBytes: 1024 });
  });
  afterAll(() => srv.close());

  it("defaults to the documented 32 MB", () => {
    expect(MAX_BLOB_BYTES).toBe(33_554_432);
  });

  it("rejects a push carrying a file over the limit and leaves refs untouched", async () => {
    const { token } = await srv.store.createRepo("default", "big");
    const remote = srv.store.remoteUrl("default", "big");
    const w = await WorkTree.init(join(tmp.path, "w-big"));
    await w.commit("small", { "ok.txt": "x".repeat(1024) });
    const ok = await git(["-C", w.dir, ...bearer(token), "push", remote, "main"]);
    expect(ok.code, ok.stderr).toBe(0);

    await w.commit("large", { "assets/huge.bin": "y".repeat(1025) });
    const r = await git(["-C", w.dir, ...bearer(token), "push", remote, "main"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("assets/huge.bin (1025 bytes) exceeds the Artifacts limit of 1024 bytes per file");
    const pushed = srv.store.events.history.filter((e) => e.type === "cf.artifacts.repo.pushed");
    expect(pushed).toHaveLength(1);
    expect(await srv.store.listRepos("default")).toMatchObject({ total: 1 });
  });

  it("checks new branches against everything already in the repo", async () => {
    const { token } = await srv.store.createRepo("default", "branchy");
    const remote = srv.store.remoteUrl("default", "branchy");
    const w = await WorkTree.init(join(tmp.path, "w-branchy"));
    await w.commit("base", { "a.txt": "a" });
    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    await w.run(["checkout", "-q", "-b", "topic"]);
    await w.commit("big on topic", { "b.bin": "z".repeat(2048) });
    const r = await git(["-C", w.dir, ...bearer(token), "push", remote, "topic"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("b.bin (2048 bytes)");
    // Deleting a branch carries no objects and is never refused.
    await w.run(["checkout", "-q", "main"]);
    await w.run(["branch", "side"]);
    await w.run([...bearer(token), "push", "-q", remote, "side"]);
    const del = await git(["-C", w.dir, ...bearer(token), "push", remote, ":side"]);
    expect(del.code, del.stderr).toBe(0);
  });
});

describe("push times", () => {
  it("updates last_push_at on push only when trackPushTimes is on", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "tracked"), trackPushTimes: true });
    try {
      const { token } = await s.store.createRepo("default", "t");
      const w = await WorkTree.init(join(tmp.path, "w-tracked"));
      await w.commit("x");
      await w.run([...bearer(token), "push", "-q", s.store.remoteUrl("default", "t"), "main"]);
      expect((await s.store.getReadyRepo("default", "t")).lastPushAt).not.toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe("persistence", () => {
  it("keeps repos, history, and tokens across a restart", async () => {
    const dataDir = join(tmp.path, "persist");
    const a = await startServer({ dataDir, port: 0 });
    const { token } = await a.store.createRepo("default", "kept");
    const remote = a.store.remoteUrl("default", "kept");
    const w = await WorkTree.init(join(tmp.path, "w-kept"));
    await w.commit("survives");
    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    const read = await a.store.createToken("default", "kept", "read", 3600);
    await a.close();

    const b = await startServer({ dataDir });
    try {
      const meta = await b.store.getReadyRepo("default", "kept");
      expect(meta.name).toBe("kept");
      const ls = await git([...bearer(read.plaintext), "ls-remote", b.store.remoteUrl("default", "kept")]);
      expect(ls.code, ls.stderr).toBe(0);
      expect(ls.stdout.toString()).toContain("refs/heads/main");
    } finally {
      await b.close();
    }
  });
});

describe("repository size limit", () => {
  it("refuses a push that would grow the repository past maxRepoBytes", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "repo-limit"), maxRepoBytes: 200 * 1024 });
    try {
      const { token } = await s.store.createRepo("default", "sized");
      const remote = s.store.remoteUrl("default", "sized");
      const w = await WorkTree.init(join(tmp.path, "w-sized"));
      await w.commit("small", { "small.txt": "x" });
      const ok = await git(["-C", w.dir, ...bearer(token), "push", remote, "main"]);
      expect(ok.code, ok.stderr).toBe(0);
      // Random bytes do not compress, so this alone exceeds the limit.
      await w.commit("big", { "big.bin": randomBytes(300 * 1024).toString("base64") });
      const r = await git(["-C", w.dir, ...bearer(token), "push", remote, "main"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(
        /would grow the repository to about \d+ bytes, over the Artifacts limit of 204800 bytes/,
      );
    } finally {
      await s.close();
    }
  });

  it("defaults to the documented 1 GB", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "repo-default") });
    try {
      expect(s.store.maxRepoBytes).toBe(1024 ** 3);
    } finally {
      await s.close();
    }
  });
});

describe("rate limiting", () => {
  it("throttles each namespace and each repo separately, and records rateLimited", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "rate"), rateLimit: { requests: 4, windowMs: 60_000 } });
    try {
      const rest = (ns: string) =>
        fetch(`${s.url}/client/v4/accounts/a/artifacts/namespaces/${ns}/repos`, {
          headers: { authorization: "Bearer x" },
        });
      for (let i = 0; i < 4; i++) expect((await rest("ns-a")).status).toBe(200);
      const limited = await rest("ns-a");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(await limited.json()).toMatchObject({
        success: false,
        errors: [{ code: 971, message: "Please wait and consider throttling your request speed" }],
      });
      expect((await rest("ns-b")).status).toBe(200);
      expect((await fetch(`${s.url}/__local/health`)).status).toBe(200);

      const { token } = await s.store.createRepo("default", "busy");
      const remote = s.store.remoteUrl("default", "busy");
      // Each ls-remote is two HTTP requests (info/refs, then ls-refs); the limit counts requests.
      for (let i = 0; i < 2; i++) expect((await git([...bearer(token), "ls-remote", remote])).code).toBe(0);
      const refused = await git([...bearer(token), "ls-remote", remote]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("429");

      const groups = s.store.metrics.groups({ eventType: "rateLimited" }, ["repository", "repositoryNamespace"]);
      expect(groups.map((g) => [g.dimensions.repositoryNamespace, g.count])).toEqual(
        expect.arrayContaining([
          ["ns-a", 1],
          ["default", 1],
        ]),
      );
    } finally {
      await s.close();
    }
  });
});

describe("fault injection", () => {
  it("answers REST, git, and binding calls with a 500 at failRate 1, and records serverError", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "faults"), faults: { failRate: 1 } }, [handleBinding]);
    try {
      const res = await fetch(`${s.url}/client/v4/accounts/a/artifacts/namespaces/default/repos`, {
        headers: { authorization: "Bearer x" },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ errors: [{ code: 10400 }] });
      const { token } = await s.store.createRepo("default", "flaky");
      const ls = await git([...bearer(token), "ls-remote", s.store.remoteUrl("default", "flaky")]);
      expect(ls.code).not.toBe(0);
      expect(ls.stderr).toContain("500");
      const artifacts = createArtifactsBinding({ url: s.url, namespace: "default" });
      await expect(artifacts.list()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect((await fetch(`${s.url}/__local/health`)).status).toBe(200);
      expect(s.store.metrics.groups({ eventType: "serverError" }, ["errorMessage"])[0]).toMatchObject({
        count: 3,
        dimensions: { errorMessage: "injected failure" },
      });
    } finally {
      await s.close();
    }
  });

  it("adds latency without failing", async () => {
    const s = await startServer({ dataDir: join(tmp.path, "slowpoke"), faults: { latencyMs: 150 } });
    try {
      const t = Date.now();
      const res = await fetch(`${s.url}/client/v4/accounts/a/artifacts/namespaces/default/repos`, {
        headers: { authorization: "Bearer x" },
      });
      expect(res.status).toBe(200);
      expect(Date.now() - t).toBeGreaterThanOrEqual(140);
    } finally {
      await s.close();
    }
  });
});

describe("classify", () => {
  it.each([
    ["/client/v4/accounts/a/artifacts/namespaces", { surface: "rest", key: "ns:", namespace: "", repo: "" }],
    [
      "/client/v4/accounts/a/artifacts/namespaces/n/repos/r/log",
      { surface: "rest", key: "ns:n", namespace: "n", repo: "r" },
    ],
    ["/git/n/r.git/info/refs", { surface: "git", key: "repo:n/r", namespace: "n", repo: "r" }],
    ["/__local/binding/n", { surface: "binding", key: "ns:n", namespace: "n", repo: "" }],
    ["/__local/health", null],
    ["/elsewhere", null],
  ])("%s", (path, expected) => {
    expect(classify(path)).toEqual(expected);
  });
});
