import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { EventBus, webhookListener } from "../src/events.ts";
import { gitOk, log, resolveCommit } from "../src/git.ts";
import { Store, importError, importSource } from "../src/store.ts";
import { WorkTree, tempDir } from "./helpers.ts";

let tmp: Awaited<ReturnType<typeof tempDir>>;
let store: Store;
let clock: number;

beforeEach(async () => {
  tmp = await tempDir();
  clock = Date.parse("2026-10-08T00:00:00Z");
  store = new Store({
    dataDir: join(tmp.path, "data"),
    accountId: "acct",
    now: () => clock,
    allowInsecureImport: true,
  });
});

afterEach(() => tmp.cleanup());

/** Push a work tree with two branches into a store repo. */
async function seed(ns: string, repo: string): Promise<WorkTree> {
  const w = await WorkTree.init(join(tmp.path, `work-${repo}`));
  await w.commit("init", { "README.md": "hi\n" });
  await w.run(["checkout", "-q", "-b", "dev"]);
  await w.commit("dev work", { "dev.txt": "d\n" });
  await w.run(["checkout", "-q", "main"]);
  await w.run(["push", "-q", store.gitDir(ns, repo), "main", "dev"]);
  return w;
}

describe("namespaces", () => {
  it("creates, gets, lists, and deletes", async () => {
    const ns = await store.createNamespace("prod", "eu");
    expect(ns).toEqual({
      name: "prod",
      jurisdiction: "eu",
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    });
    expect(await store.countRepos("prod")).toBe(0);
    await store.createRepo("prod", "one");
    expect(await store.countRepos("prod")).toBe(1);
    expect(await store.countRepos("nowhere")).toBe(0);
    await store.deleteRepo("prod", "one");
    expect(await store.getNamespace("prod")).toEqual(ns);
    await store.createNamespace("dev");
    expect((await store.listNamespaces()).items.map((n) => n.name)).toEqual(["dev", "prod"]);
    const page = await store.listNamespaces({ limit: 1 });
    expect(page.items.map((n) => n.name)).toEqual(["dev"]);
    expect((await store.listNamespaces({ limit: 1, cursor: page.nextCursor })).items.map((n) => n.name)).toEqual([
      "prod",
    ]);
    await store.deleteNamespace("prod");
    await expect(store.getNamespace("prod")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects duplicates, bad names, and bad jurisdictions", async () => {
    await store.createNamespace("prod");
    await expect(store.createNamespace("prod")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(store.createNamespace("x")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.createNamespace("ok", "asia")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.deleteNamespace("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists nothing before any namespace exists", async () => {
    expect(await store.listNamespaces()).toEqual({ items: [], total: 0, nextCursor: undefined });
    await expect(store.listNamespaces({ cursor: "garbage" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("createRepo", () => {
  it("auto-creates the namespace and returns metadata with a write token", async () => {
    const { meta, token } = await store.createRepo("default", "app", { description: "d" });
    expect(meta).toMatchObject({
      name: "app",
      namespace: "default",
      description: "d",
      defaultBranch: "main",
      readOnly: false,
      source: null,
      lastPushAt: null,
      status: "ready",
    });
    expect(meta.id).toMatch(/^[0-9a-z]{16}$/);
    expect(token).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);
    expect(await store.getNamespace("default")).toMatchObject({ name: "default" });
    expect(await store.authenticate("default", "app", token, "write")).toBe("ok");
    expect(store.remoteUrl("default", "app")).toBe("http://127.0.0.1:8788/git/default/app.git");
  });

  it("honours a custom default branch and read-only flag", async () => {
    const { meta } = await store.createRepo("default", "app", { defaultBranch: "trunk", readOnly: true });
    expect(meta).toMatchObject({ defaultBranch: "trunk", readOnly: true });
    const head = await gitOk(["--git-dir", store.gitDir("default", "app"), "symbolic-ref", "HEAD"]);
    expect(head.toString().trim()).toBe("refs/heads/trunk");
  });

  it("rejects bad names and bad branches without leaving a directory", async () => {
    await expect(store.createRepo("default", "-bad")).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
    await expect(store.createRepo("default", "app", { defaultBranch: "a..b" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(store.createRepo("default", "app", { defaultBranch: "-x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect((await store.listRepos("default")).total).toBe(0);
  });

  it("lets exactly one of many concurrent creates win", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.createRepo("default", "race")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === "rejected")) {
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "ALREADY_EXISTS" });
    }
  });
});

describe("getReadyRepo / deleteRepo", () => {
  it("reports NOT_FOUND and deletes idempotently", async () => {
    await expect(store.getReadyRepo("default", "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { meta } = await store.createRepo("default", "app");
    expect(await store.deletedRepoId("default", "app")).toBeNull();
    expect((await store.deleteRepo("default", "app"))?.id).toBe(meta.id);
    expect(await store.deleteRepo("default", "app")).toBeNull();
    expect(await store.deletedRepoId("default", "app")).toBe(meta.id);
    await expect(store.getReadyRepo("default", "app")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listRepos", () => {
  beforeEach(async () => {
    for (const name of ["bravo", "alpha", "charlie"]) {
      clock += 1000;
      await store.createRepo("default", name);
    }
  });

  it("sorts by created_at desc by default", async () => {
    const r = await store.listRepos("default");
    expect(r.repos.map((m) => m.name)).toEqual(["charlie", "alpha", "bravo"]);
    expect(r.total).toBe(3);
    expect(r.nextCursor).toBeUndefined();
  });

  it("sorts by name either way and searches", async () => {
    expect((await store.listRepos("default", { sort: "name", direction: "asc" })).repos.map((m) => m.name)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    const s = await store.listRepos("default", { search: "AL" });
    expect(s.repos.map((m) => m.name)).toEqual(["alpha"]);
    expect(s.total).toBe(1);
  });

  it("sorts by last_push_at with never-pushed repos last in desc order", async () => {
    clock += 1000;
    await store.recordPush("default", "bravo");
    const r = await store.listRepos("default", { sort: "last_push_at" });
    expect(r.repos[0]!.name).toBe("bravo");
    expect(r.repos[0]!.lastPushAt).toBe(new Date(clock).toISOString());
  });

  it("paginates with an opaque cursor", async () => {
    const p1 = await store.listRepos("default", { limit: 2 });
    expect(p1.repos).toHaveLength(2);
    const p2 = await store.listRepos("default", { limit: 2, cursor: p1.nextCursor });
    expect(p2.repos.map((m) => m.name)).toEqual(["bravo"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("validates limit, sort, direction, and cursor", async () => {
    await expect(store.listRepos("default", { limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.listRepos("default", { limit: 201 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.listRepos("default", { sort: "size" as never })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(store.listRepos("default", { direction: "up" as never })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      store.listRepos("default", { cursor: Buffer.from('{"o":-1}').toString("base64url") }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("returns an empty page for an unknown namespace", async () => {
    expect(await store.listRepos("ghost")).toEqual({ repos: [], total: 0, nextCursor: undefined });
  });
});

describe("forkRepo", () => {
  it("copies every branch and does not inherit the description (live behaviour)", async () => {
    await store.createRepo("default", "base", { description: "base repo" });
    await seed("default", "base");
    const f = await store.forkRepo("default", "base", "copy");
    expect(f.meta).toMatchObject({
      name: "copy",
      source: "artifacts:default/base",
      description: null,
      defaultBranch: "main",
      status: "ready",
    });
    expect(f.objects).toBeGreaterThan(0);
    expect(f.token).toMatch(/^art_v2_x_/);
    const dir = store.gitDir("default", "copy");
    expect(await resolveCommit(dir, "main")).toBe(await resolveCommit(store.gitDir("default", "base"), "main"));
    expect(await resolveCommit(dir, "dev")).not.toBeNull();
    const remotes = await gitOk(["--git-dir", dir, "remote"]);
    expect(remotes.toString()).toBe("");
  });

  it("copies every branch when defaultBranchOnly is false", async () => {
    await store.createRepo("default", "base");
    await seed("default", "base");
    await store.forkRepo("default", "base", "full", { defaultBranchOnly: false, readOnly: true, description: "x" });
    const meta = await store.getReadyRepo("default", "full");
    expect(meta).toMatchObject({ readOnly: true, description: "x" });
    expect(await resolveCommit(store.gitDir("default", "full"), "dev")).not.toBeNull();
  });

  it("forks an empty repository", async () => {
    await store.createRepo("default", "empty", { defaultBranch: "trunk" });
    const f = await store.forkRepo("default", "empty", "empty2");
    expect(f.meta.defaultBranch).toBe("trunk");
    expect(await log(store.gitDir("default", "empty2"))).toEqual([]);
  });

  it("rejects an existing target and a missing source", async () => {
    await store.createRepo("default", "a");
    await store.createRepo("default", "b");
    await expect(store.forkRepo("default", "a", "b")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(store.forkRepo("default", "zzz", "c")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.forkRepo("default", "a", "bad/name")).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
  });

  it("is visible as forking while in progress", async () => {
    const slow = new Store({ dataDir: store.dataDir, now: () => clock, asyncDelayMs: 300 });
    await slow.createRepo("default", "base");
    const pending = slow.forkRepo("default", "base", "slowcopy");
    await vi.waitFor(async () => {
      await expect(slow.getReadyRepo("default", "slowcopy")).rejects.toMatchObject({ code: "FORK_IN_PROGRESS" });
    });
    const listed = await slow.listRepos("default", { search: "slowcopy" });
    expect(listed.repos[0]!.status).toBe("forking");
    await expect(slow.forkRepo("default", "base", "slowcopy")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await pending;
    expect((await slow.getReadyRepo("default", "slowcopy")).status).toBe("ready");
  });
});

describe("importRepo", () => {
  let source: string;
  beforeEach(async () => {
    const w = await WorkTree.init(join(tmp.path, "upstream"), "trunk");
    await w.commit("one", { "a.txt": "1\n" });
    await w.commit("two", { "a.txt": "2\n" });
    await w.run(["branch", "other"]);
    source = join(tmp.path, "upstream");
  });

  it("imports the remote default branch", async () => {
    const r = await store.importRepo("default", "mirror", { url: source, description: "m" });
    // The remote's default is trunk, but like the live service the metadata reports "main".
    expect(r.meta).toMatchObject({
      defaultBranch: "main",
      source: `git:${source}.git`,
      description: "m",
      status: "ready",
    });
    const head = await gitOk(["--git-dir", store.gitDir("default", "mirror"), "symbolic-ref", "--short", "HEAD"]);
    expect(head.toString().trim()).toBe("trunk");
    expect((await log(store.gitDir("default", "mirror"))).length).toBe(2);
    expect(await resolveCommit(store.gitDir("default", "mirror"), "other")).toBeNull();
  });

  it("honours branch and depth", async () => {
    const r = await store.importRepo("default", "shallow", { url: `file://${source}`, branch: "other", depth: 1 });
    expect(r.meta.defaultBranch).toBe("other");
    expect((await log(store.gitDir("default", "shallow"))).length).toBe(1);
  });

  it("requires HTTPS unless insecure import is allowed", async () => {
    const strict = new Store({ dataDir: store.dataDir });
    await expect(strict.importRepo("default", "x", { url: source })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(strict.importRepo("default", "x", { url: "http://example.com/a.git" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("validates its parameters", async () => {
    await expect(store.importRepo("default", "x", { url: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.importRepo("default", "x", { url: source, depth: 0 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(store.importRepo("default", "x", { url: source, branch: "-x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("maps a missing source to an error and cleans up", async () => {
    await expect(store.importRepo("default", "x", { url: join(tmp.path, "nothing") })).rejects.toMatchObject({
      name: "ArtifactsError",
    });
    await expect(store.getReadyRepo("default", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is visible as importing while in progress", async () => {
    const slow = new Store({ dataDir: store.dataDir, asyncDelayMs: 300, allowInsecureImport: true });
    const pending = slow.importRepo("default", "slow", { url: source });
    await vi.waitFor(async () => {
      await expect(slow.getReadyRepo("default", "slow")).rejects.toMatchObject({ code: "IMPORT_IN_PROGRESS" });
    });
    await pending;
  });
});

describe("importSource / importError", () => {
  it("records the source as git:<url>.git, as live does", () => {
    expect(importSource("https://github.com/octocat/Hello-World")).toBe(
      "git:https://github.com/octocat/Hello-World.git",
    );
    expect(importSource("https://github.com/a/b.git")).toBe("git:https://github.com/a/b.git");
    expect(importSource("https://gitlab.com/g/p/")).toBe("git:https://gitlab.com/g/p.git");
  });

  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "REMOTE_AUTH_REQUIRED"],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", "UPSTREAM_UNAVAILABLE"],
    ["fatal: repository 'https://example.com/' not found", "INVALID_URL"],
    ["fatal: 'x' does not appear to be a git repository", "INVALID_URL"],
  ])("maps %j to %s", (stderr, code) => {
    expect(importError(stderr).code).toBe(code);
  });
});

describe("tokens", () => {
  beforeEach(() => store.createRepo("default", "app"));

  it("creates, lists by state, and revokes by id or plaintext", async () => {
    const read = await store.createToken("default", "app", "read", 60);
    const write = await store.createToken("default", "app", undefined, undefined);
    expect(read.info).toMatchObject({ scope: "read", state: "active" });
    expect(write.info.scope).toBe("write");

    // The initial token from create plus the two above.
    expect(await store.listTokens("default", "app")).toHaveLength(3);
    expect(await store.revokeToken("default", "app", read.info.id)).toBe(true);
    expect(await store.revokeToken("default", "app", read.info.id)).toBe(false);
    expect(await store.revokeToken("default", "app", write.plaintext)).toBe(true);
    expect(await store.revokeToken("default", "app", "unknown")).toBe(false);
    expect(await store.listTokens("default", "app", "revoked")).toHaveLength(2);
    expect(await store.listTokens("default", "app", "active")).toHaveLength(1);
    await expect(store.revokeToken("default", "app", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("expires tokens on the clock", async () => {
    const t = await store.createToken("default", "app", "read", 60);
    clock += 61_000;
    expect((await store.listTokens("default", "app", "expired")).map((x) => x.id)).toContain(t.info.id);
    expect(await store.authenticate("default", "app", t.plaintext, "read")).toBe("unauthorized");
  });

  it("authenticates by scope", async () => {
    const r = await store.createToken("default", "app", "read", 3600);
    const secret = r.plaintext.split("?")[0]!;
    expect(await store.authenticate("default", "app", secret, "read")).toBe("ok");
    expect(await store.authenticate("default", "app", r.plaintext, "write")).toBe("forbidden");
    expect(await store.authenticate("default", "app", "garbage", "read")).toBe("unauthorized");
    expect(await store.authenticate("default", "app", `art_v2_x_${"0".repeat(40)}`, "read")).toBe("unauthorized");
  });

  it("does not let one repo's token open another", async () => {
    await store.createRepo("default", "other");
    const t = await store.createToken("default", "app", "write", 3600);
    expect(await store.authenticate("default", "other", t.plaintext, "read")).toBe("unauthorized");
  });

  it("revokes by id across a namespace", async () => {
    await store.createRepo("default", "other");
    const t = await store.createToken("default", "other", "read", 3600);
    expect(await store.revokeTokenById("default", t.info.id)).toBe("revoked");
    expect(await store.revokeTokenById("default", t.info.id)).toBe("already-revoked");
    expect(await store.revokeTokenById("default", "nosuchtoken")).toBe("missing");
  });

  it("rejects tokens for missing repos and bad TTLs", async () => {
    await expect(store.createToken("default", "nope", "read", 60)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.createToken("default", "app", "read", 5)).rejects.toMatchObject({ code: "INVALID_TTL" });
  });
});

describe("events", () => {
  it("emits lifecycle events in the documented envelope", async () => {
    await store.createRepo("default", "base");
    await store.forkRepo("default", "base", "copy");
    const t = await store.createToken("default", "copy", "read", 60);
    await store.revokeToken("default", "copy", t.info.id);
    await store.deleteRepo("default", "copy");
    const types = store.events.history.map((e) => e.type);
    expect(types).toEqual([
      "cf.artifacts.repo.created",
      "cf.artifacts.repo.token.created",
      "cf.artifacts.repo.forked",
      "cf.artifacts.repo.token.created",
      "cf.artifacts.repo.token.created",
      "cf.artifacts.repo.token.revoked",
      "cf.artifacts.repo.deleted",
    ]);
    const forked = store.events.history.find((e) => e.type === "cf.artifacts.repo.forked")!;
    expect(forked.source).toEqual({ type: "artifacts", namespace: "default", repoName: "base" });
    expect(forked.payload).toMatchObject({ namespace: "default", repoName: "copy" });
    expect(forked.metadata).toMatchObject({ accountId: "acct", eventSchemaVersion: 1 });
    const tok = store.events.history.find((e) => e.type === "cf.artifacts.repo.token.revoked")!;
    expect(tok.source.type).toBe("artifacts.repo");
    expect(tok.payload).toEqual({ tokenId: t.info.id });
  });

  it("delivers to subscribers, isolates failures, and caps history", async () => {
    const bus = new EventBus("a", () => 0, 2);
    const seen: string[] = [];
    const unsub = bus.subscribe((e) => {
      seen.push(e.type);
    });
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.emit("cf.artifacts.repo.pushed", "n", "r", {});
    bus.emit("cf.artifacts.repo.cloned", "n", "r", {});
    bus.emit("cf.artifacts.repo.fetched", "n", "r", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["cf.artifacts.repo.pushed", "cf.artifacts.repo.cloned", "cf.artifacts.repo.fetched"]);
    expect(bus.history.map((e) => e.type)).toEqual(["cf.artifacts.repo.cloned", "cf.artifacts.repo.fetched"]);
    unsub();
    bus.emit("cf.artifacts.repo.pushed", "n", "r", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(3);
  });

  it("posts events to a webhook", async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(null);
    }) as unknown as typeof fetch;
    const bus = new EventBus("a");
    const ev = bus.emit("cf.artifacts.repo.pushed", "n", "r", { ref: "refs/heads/main" });
    await webhookListener("http://hook", fake)(ev);
    expect(calls[0]![0]).toBe("http://hook");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual(ev);
  });
});
