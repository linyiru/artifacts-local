import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { build } from "rolldown";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { handleBinding } from "../src/binding-rpc.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

// Runs the shim inside real workerd and calls it over a service binding, the way a Worker
// under `wrangler dev` would call env.ARTIFACTS.

const APP = `
const results = {};
async function capture(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: { name: e.name, code: e.code, numericCode: e.numericCode, message: e.message, isError: e instanceof Error } }; }
}
async function blobInfo(b) {
  if (b === null) return null;
  return { isBlob: b instanceof Blob, type: b.type, size: b.size, text: await b.text() };
}
export default {
  async fetch(req, env) {
    const s = new URL(req.url).pathname.slice(1);
    const A = env.ARTIFACTS;
    if (s === "read") {
      using repo = await A.get("seeded");
      const info = await repo.info();
      const history = await repo.log({ ref: "main" });
      const commit = await repo.readCommit(history[0].hash);
      const tree = await repo.readTree(commit.treeHash);
      const readme = tree.find((e) => e.name === "README.md");
      return Response.json({
        info,
        messages: history.map((c) => c.message),
        commitKeys: Object.keys(commit).sort(),
        tree: tree.map((e) => [e.name, e.type, e.mode]).sort(),
        blob: await blobInfo(await repo.readBlob(readme.hash)),
        notBlob: await repo.readBlob(commit.hash),
        file: await blobInfo(await repo.readFile({ ref: "main", path: "README.md" })),
        binary: (await repo.readFile({ ref: "main", path: "data.bin" }))?.type,
        missingFile: await repo.readFile({ ref: "main", path: "nope" }),
        badHash: await capture(() => repo.readCommit("XYZ")),
      });
    }
    if (s === "lifecycle") {
      const created = await A.create("wd-repo", { description: "from workerd" });
      using repo = await A.get("wd-repo");
      const token = await repo.createToken("read", 120);
      const tokens = await repo.listTokens();
      const revoked = await repo.revokeToken(token.id);
      const badTtl = await capture(() => repo.createToken("read", 1));
      const fork = await repo.fork("wd-fork");
      const page = await A.list({ limit: 200 });
      const dup = await capture(() => A.create("wd-repo"));
      const deleted = await A.delete("wd-fork");
      const deletedAgain = await A.delete("wd-fork");
      return Response.json({
        createdKeys: Object.keys(created).sort(),
        created,
        token: { scope: token.scope, plaintextOk: /^art_v2_x_[0-9a-f]{40}\\?expires=\\d+$/.test(token.plaintext) },
        tokenTotal: tokens.total,
        revoked,
        badTtl,
        fork,
        listed: page.repos.map((r) => ({ name: r.name, status: r.status, hasRemote: "remote" in r })),
        dup,
        deleted,
        deletedAgain,
      });
    }
    if (s === "missing") {
      return Response.json(await capture(() => A.get("does-not-exist")));
    }
    if (s === "forking") {
      using src = await A.get("slow-src");
      const pending = src.fork("slow-dst");
      await new Promise((r) => setTimeout(r, 150));
      const during = await capture(() => A.get("slow-dst"));
      await pending;
      const after = await capture(async () => { using r = await A.get("slow-dst"); return (await r.info()).name; });
      return Response.json({ during, after });
    }
    return new Response("unknown scenario", { status: 404 });
  },
};`;

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let slow: RunningServer;
let mf: Miniflare;

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data") }, [handleBinding]);
  slow = await startServer({ dataDir: join(tmp.path, "slow"), asyncDelayMs: 400 }, [handleBinding]);

  const seeded = await srv.store.createRepo("wd", "seeded");
  const w = await WorkTree.init(join(tmp.path, "w"));
  await w.commit("first", { "README.md": "# from git\n" });
  await w.write("data.bin", Buffer.from([0, 159, 146, 150]));
  await w.commit("second");
  await w.run([
    "-c",
    `http.extraHeader=Authorization: Bearer ${seeded.token}`,
    "push",
    "-q",
    srv.store.remoteUrl("wd", "seeded"),
    "main",
  ]);
  await slow.store.createRepo("default", "slow-src");

  const shim = await build({
    input: join(import.meta.dirname, "../worker/shim.ts"),
    platform: "neutral",
    external: ["cloudflare:workers"],
    write: false,
    output: { format: "esm" },
  });
  const shimCode = shim.output[0].code;
  const shimWorker = (name: string, url: string) => ({
    name,
    modules: [{ type: "ESModule" as const, path: "shim.js", contents: shimCode }],
    compatibilityDate: "2026-09-01",
    bindings: { ARTIFACTS_LOCAL_URL: url },
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: true,
          script: APP,
          compatibilityDate: "2026-09-01",
          serviceBindings: { ARTIFACTS: { name: "shim", entrypoint: "ArtifactsLocal", props: { namespace: "wd" } } },
        },
        {
          name: "slow-app",
          modules: true,
          script: APP,
          compatibilityDate: "2026-09-01",
          serviceBindings: { ARTIFACTS: { name: "slow-shim", entrypoint: "ArtifactsLocal" } },
        },
        shimWorker("shim", srv.url),
        shimWorker("slow-shim", slow.url),
      ],
    }),
  );
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  await srv?.close();
  await slow?.close();
  await tmp?.cleanup();
});

async function scenario(name: string, worker = "app"): Promise<any> {
  // getWorker's declared type lags its runtime shape, which is a fetcher.
  const w = (await mf.getWorker(worker)) as unknown as { fetch(url: string): Promise<Response> };
  const res = await w.fetch(`http://app/${name}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

describe("shim inside workerd", () => {
  it("reads repo content, with Blobs crossing RPC intact", async () => {
    const r = await scenario("read");
    expect(r.info).toMatchObject({
      name: "seeded",
      defaultBranch: "main",
      remote: srv.store.remoteUrl("wd", "seeded"),
    });
    expect(r.messages).toEqual(["second", "first"]);
    expect(r.commitKeys).toEqual([
      "author",
      "authoredAt",
      "committedAt",
      "committer",
      "hash",
      "message",
      "parents",
      "treeHash",
    ]);
    expect(r.tree).toEqual([
      ["README.md", "blob", "100644"],
      ["data.bin", "blob", "100644"],
    ]);
    expect(r.blob).toEqual({ isBlob: true, type: "", size: 11, text: "# from git\n" });
    expect(r.notBlob).toBeNull();
    expect(r.file).toEqual({ isBlob: true, type: "text/plain;charset=utf-8", size: 11, text: "# from git\n" });
    expect(r.binary).toBe("application/octet-stream");
    expect(r.missingFile).toBeNull();
    expect(r.badHash).toMatchObject({
      ok: false,
      error: { name: "ArtifactsError", code: "INVALID_INPUT", numericCode: 10100, isError: true },
    });
  });

  it("runs the repo lifecycle", async () => {
    const r = await scenario("lifecycle");
    expect(r.createdKeys).toEqual(["defaultBranch", "description", "id", "name", "remote", "token"]);
    expect(r.created).toMatchObject({
      name: "wd-repo",
      description: "from workerd",
      remote: srv.store.remoteUrl("wd", "wd-repo"),
    });
    expect(r.token).toEqual({ scope: "read", plaintextOk: true });
    expect(r.tokenTotal).toBe(2);
    expect(r.revoked).toBe(true);
    expect(r.badTtl).toMatchObject({ ok: false, error: { code: "INVALID_TTL", numericCode: 10103 } });
    expect(r.fork).toMatchObject({ name: "wd-fork", description: null });
    expect(r.listed).toContainEqual({ name: "wd-fork", status: "ready", hasRemote: false });
    expect(r.dup).toMatchObject({ ok: false, error: { code: "ALREADY_EXISTS", numericCode: 10201 } });
    expect(r.deleted).toBe(true);
    expect(r.deletedAgain).toBe(false);
  });

  it("throws ArtifactsError NOT_FOUND from get()", async () => {
    expect(await scenario("missing")).toEqual({
      ok: false,
      error: {
        name: "ArtifactsError",
        code: "NOT_FOUND",
        numericCode: 10200,
        message: "Repository not found",
        isError: true,
      },
    });
  });

  it("throws FORK_IN_PROGRESS while a fork runs, using the env namespace fallback", async () => {
    const r = await scenario("forking", "slow-app");
    expect(r.during).toMatchObject({ ok: false, error: { code: "FORK_IN_PROGRESS", numericCode: 10303 } });
    expect(r.after).toEqual({ ok: true, value: "slow-dst" });
  });
});
