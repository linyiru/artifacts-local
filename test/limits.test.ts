import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { MAX_BLOB_BYTES } from "../src/store.ts";
import { type RunningServer, startServer } from "../src/server.ts";
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
    expect((await srv.store.listRepos("default")).repos[0]!.lastPushAt).not.toBeNull();
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
      expect(meta.lastPushAt).not.toBeNull();
      const ls = await git([...bearer(read.plaintext), "ls-remote", b.store.remoteUrl("default", "kept")]);
      expect(ls.code, ls.stderr).toBe(0);
      expect(ls.stdout.toString()).toContain("refs/heads/main");
    } finally {
      await b.close();
    }
  });
});
