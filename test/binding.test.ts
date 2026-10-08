import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { dispatch, handleBinding } from "../src/binding-rpc.ts";
import { createArtifactsBinding } from "../src/client.ts";
import type { Artifacts } from "../src/types.ts";
import { ArtifactsError } from "../src/errors.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let artifacts: Artifacts;

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data"), allowInsecureImport: true }, [handleBinding]);
  artifacts = createArtifactsBinding({ url: `${srv.url}/`, namespace: "default" });
});

afterAll(async () => {
  await srv.close();
  await tmp.cleanup();
});

async function rejectsWith(p: Promise<unknown>, code: string, numericCode?: number) {
  const err = await p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArtifactsError);
  expect(err).toMatchObject({ name: "ArtifactsError", code });
  if (numericCode) expect((err as ArtifactsError).numericCode).toBe(numericCode);
}

async function seed(remote: string, token: string): Promise<WorkTree> {
  const w = await WorkTree.init(join(tmp.path, `w-${Math.random().toString(36).slice(2)}`));
  await w.commit("init", { "README.md": "# hi\n", "src/app.ts": "export {};\n" });
  await w.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  await w.commit("add logo");
  await w.run(["branch", "side"]);
  await w.run(["-c", `http.extraHeader=Authorization: Bearer ${token}`, "push", "-q", remote, "main", "side"]);
  return w;
}

describe("namespace methods", () => {
  it("create returns ArtifactsCreateRepoResult", async () => {
    const r = (await artifacts.create("starter-repo", {
      description: "Repository for automation experiments",
      readOnly: false,
      setDefaultBranch: "main",
    }));
    expect(Object.keys(r).sort()).toEqual(["defaultBranch", "description", "id", "name", "remote", "token"]);
    expect(r).toMatchObject({
      name: "starter-repo",
      description: "Repository for automation experiments",
      defaultBranch: "main",
      remote: `${srv.url}/git/default/starter-repo.git`,
    });
    expect(r.token).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);
  });

  it("create rejects bad and duplicate names", async () => {
    await rejectsWith(artifacts.create("bad name"), "INVALID_REPO_NAME", 10101);
    await artifacts.create("twice");
    await rejectsWith(artifacts.create("twice"), "ALREADY_EXISTS", 10201);
  });

  it("get throws NOT_FOUND for a missing repo", async () => {
    await rejectsWith(artifacts.get("missing"), "NOT_FOUND", 10200);
  });

  it("list returns repos without remote, with status, total, and cursor", async () => {
    const page = await artifacts.list({ limit: 1 });
    expect(page.repos).toHaveLength(1);
    expect(page.repos[0]).not.toHaveProperty("remote");
    expect(page.repos[0]!.status).toBe("ready");
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.cursor).toEqual(expect.any(String));
    const next = await artifacts.list({ limit: 200, cursor: page.cursor });
    expect(next).not.toHaveProperty("cursor");
    await rejectsWith(artifacts.list({ limit: 500 }), "INVALID_INPUT");
  });

  it("delete returns a boolean", async () => {
    await artifacts.create("deleteme");
    expect(await artifacts.delete("deleteme")).toBe(true);
    expect(await artifacts.delete("deleteme")).toBe(false);
  });

  it("import brings in a remote's default branch", async () => {
    const up = await WorkTree.init(join(tmp.path, "upstream"), "trunk");
    await up.commit("upstream");
    const r = (await artifacts.import({
      source: { url: up.dir, depth: 1 },
      target: { name: "imported", opts: { description: "mirror", readOnly: true } },
    }));
    expect(r).toMatchObject({ name: "imported", defaultBranch: "trunk", description: "mirror" });
    using repo = await artifacts.get("imported");
    expect(await repo.info()).toMatchObject({ readOnly: true, source: up.dir });
  });
});

describe("repository capability", () => {
  let token: string;
  beforeAll(async () => {
    const r = await artifacts.create("content");
    token = r.token;
    await seed(r.remote, token);
  });

  it("info returns ArtifactsRepoInfo", async () => {
    using repo = await artifacts.get("content");
    const i = (await repo.info());
    expect(Object.keys(i).sort()).toEqual([
      "createdAt", "defaultBranch", "description", "id", "lastPushAt", "name", "readOnly", "remote", "source", "status", "updatedAt",
    ]);
    expect(i.lastPushAt).toEqual(expect.any(String));
  });

  it("log, readCommit, readTree, readBlob, readFile behave as documented", async () => {
    using repo = await artifacts.get("content");
    const history = await repo.log({ ref: "main", limit: 10 });
    expect(history.map((c) => c.message)).toEqual(["add logo", "init"]);
    expect(await repo.log({ ref: "does-not-exist" })).toEqual([]);

    const commit = (await repo.readCommit(history[0]!.hash))!;
    expect(Object.keys(commit).sort()).toEqual([
      "author", "authoredAt", "committedAt", "committer", "hash", "message", "parents", "treeHash",
    ]);
    expect(await repo.readCommit("0".repeat(40))).toBeNull();
    await rejectsWith(repo.readCommit("not-a-hash"), "INVALID_INPUT", 10100);

    const tree = (await repo.readTree(history[0]!.treeHash))!;
    expect(tree.map((e) => e.name).sort()).toEqual(["README.md", "logo.png", "src"]);
    expect(await repo.readTree("0".repeat(40))).toBeNull();

    const readme = tree.find((e) => e.name === "README.md")!;
    const blob = await repo.readBlob(readme.hash);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe("");
    expect(await blob!.text()).toBe("# hi\n");
    expect(await repo.readBlob(history[0]!.hash)).toBeNull();

    const text = await repo.readFile({ ref: "main", path: "README.md" });
    expect(text!.type).toBe("text/plain;charset=utf-8");
    const bin = await repo.readFile({ ref: "main", path: "logo.png" });
    expect(bin!.type).toBe("application/octet-stream");
    expect(new Uint8Array(await bin!.arrayBuffer())[0]).toBe(0x89);
    expect(await repo.readFile({ ref: "main", path: "src" })).toBeNull();
    expect(await repo.readFile({ ref: "main", path: "nope" })).toBeNull();
    await rejectsWith(repo.readFile({ ref: "", path: "x" }), "INVALID_INPUT");
  });

  it("createToken, listTokens, revokeToken", async () => {
    using repo = await artifacts.get("content");
    const t = (await repo.createToken("read", 3600));
    expect(Object.keys(t).sort()).toEqual(["expiresAt", "id", "plaintext", "scope"]);
    expect(t.scope).toBe("read");
    expect((await repo.createToken()).scope).toBe("write");
    await rejectsWith(repo.createToken("read", 59), "INVALID_TTL", 10103);
    await rejectsWith(repo.createToken("read", 31_536_001), "INVALID_TTL");

    const list = await repo.listTokens();
    expect(list.total).toBe(list.tokens.length);
    expect(Object.keys(list.tokens[0]!).sort()).toEqual(["createdAt", "expiresAt", "id", "scope", "state"]);

    expect(await repo.revokeToken(t.plaintext)).toBe(true);
    expect(await repo.revokeToken(t.id)).toBe(false);
    expect(await repo.revokeToken("nothing")).toBe(false);
    await rejectsWith(repo.revokeToken(""), "INVALID_INPUT");
  });

  it("fork defaults to the default branch only and is listed with its source", async () => {
    using repo = await artifacts.get("content");
    const f = (await repo.fork("content-fork", { description: "Fork for testing" }));
    expect(Object.keys(f).sort()).toEqual(["defaultBranch", "description", "id", "name", "remote", "token"]);
    using forked = await artifacts.get("content-fork");
    expect(await forked.info()).toMatchObject({ source: "artifacts:default/content", description: "Fork for testing" });
    expect(await forked.log({ ref: "side" })).toEqual([]);

    await repo.fork("content-fork-all", { defaultBranchOnly: false });
    using all = await artifacts.get("content-fork-all");
    expect((await all.log({ ref: "side" })).length).toBe(2);
    await rejectsWith(repo.fork("content-fork"), "ALREADY_EXISTS");
    await rejectsWith(repo.fork("bad/name"), "INVALID_REPO_NAME");
  });

  it("throws NOT_FOUND from a handle whose repo was deleted", async () => {
    await artifacts.create("ephemeral");
    const repo = await artifacts.get("ephemeral");
    await artifacts.delete("ephemeral");
    await rejectsWith(repo.info(), "NOT_FOUND");
    repo[Symbol.dispose]();
  });
});

describe("in-progress states", () => {
  it("get throws FORK_IN_PROGRESS while a fork runs and list shows forking", async () => {
    const slow = await startServer({ dataDir: join(tmp.path, "slow"), asyncDelayMs: 400 }, [handleBinding]);
    try {
      const a = createArtifactsBinding({ url: slow.url, namespace: "default" });
      await a.create("src");
      using src = await a.get("src");
      const pending = src.fork("dst");
      await new Promise((r) => setTimeout(r, 150));
      await rejectsWith(a.get("dst"), "FORK_IN_PROGRESS", 10303);
      const listed = await a.list();
      expect(listed.repos.find((r) => r.name === "dst")!.status).toBe("forking");
      await pending;
      using dst = await a.get("dst");
      expect(await dst.info()).toMatchObject({ status: "ready" });
    } finally {
      await slow.close();
    }
  });
});

describe("transport", () => {
  it("surfaces HTTP failures as INTERNAL_ERROR", async () => {
    const broken = createArtifactsBinding({
      url: "http://x",
      namespace: "default",
      fetch: (async () => new Response("down", { status: 502 })) as unknown as typeof fetch,
    });
    await rejectsWith(broken.create("x"), "INTERNAL_ERROR");
  });

  it("rejects unknown methods, bad namespaces, and malformed bodies", async () => {
    expect(await dispatch(srv.store, "default", { method: "explode" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await dispatch(srv.store, "default", { method: "explode", repo: "content" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await dispatch(srv.store, "x", { method: "list" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const res = await fetch(`${srv.url}/__local/binding/default`, { method: "POST", body: "{nope" });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect((await fetch(`${srv.url}/__local/binding/default`)).status).toBe(404);
  });

  it("wraps unexpected errors as INTERNAL_ERROR", async () => {
    const bad = { getReadyRepo: () => Promise.reject(new TypeError("boom")) } as never;
    expect(await dispatch(bad, "default", { method: "info", repo: "x" })).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    const bad2 = { getReadyRepo: () => Promise.reject("str") } as never;
    expect(await dispatch(bad2, "default", { method: "info", repo: "x" })).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "str" },
    });
  });
});
