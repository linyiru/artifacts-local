import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let clock: number;
let api: string;

beforeAll(async () => {
  tmp = await tempDir();
  clock = Date.now();
  srv = await startServer({ dataDir: join(tmp.path, "data"), accountId: "acct", now: () => clock });
  api = `${srv.url}/client/v4/accounts/acct/artifacts`;
});

afterAll(async () => {
  await srv.close();
  await tmp.cleanup();
});

beforeEach(() => {
  srv.store.events.history.length = 0;
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: "Bearer local", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("json") ? ((await res.json()) as Record<string, any>) : null;
  return { status: res.status, type, json, res };
}

async function createRepo(name: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/namespaces/default/repos", { name, ...extra });
  expect(r.status).toBe(201);
  return r.json!.result as { remote: string; token: string; id: string };
}

let workN = 0;
async function work(): Promise<WorkTree> {
  return WorkTree.init(join(tmp.path, `w${++workN}`));
}

const bearer = (t: string) => ["-c", `http.extraHeader=Authorization: Bearer ${t}`];

describe("REST envelope and auth", () => {
  it("rejects missing bearer with 401 / 10000", async () => {
    const res = await fetch(`${api}/namespaces`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      result: null,
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
      messages: [],
    });
  });

  it("rejects a mismatched account", async () => {
    const res = await fetch(`${srv.url}/client/v4/accounts/other/artifacts/namespaces`, {
      headers: { authorization: "Bearer x" },
    });
    expect(res.status).toBe(403);
  });

  it("enforces a configured API token", async () => {
    const strict = await startServer({ dataDir: join(tmp.path, "strict"), apiToken: "secret" });
    try {
      const base = `${strict.url}/client/v4/accounts/a/artifacts/namespaces`;
      expect((await fetch(base, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(base, { headers: { authorization: "Bearer secret" } })).status).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it("answers unknown routes and methods with a plain-text 404, as live", async () => {
    for (const [m, p] of [
      ["GET", "/nope"],
      ["PUT", "/namespaces"],
      ["PATCH", "/namespaces/default"],
      ["GET", "/namespaces/default/widgets"],
      ["GET", "/namespaces/default/tokens"],
      ["PUT", "/namespaces/default/repos"],
    ] as const) {
      const r = await call(m, p);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.type).toBe("text/plain; charset=UTF-8");
      expect(await r.res.text()).toBe("404 Not Found");
    }
    const outside = await fetch(`${srv.url}/elsewhere`);
    expect(outside.status).toBe(404);
  });

  it("shapes errors like the live service", async () => {
    const bad = await call("POST", "/namespaces/default/repos", { name: "-x" });
    expect(bad.json!.errors).toEqual([
      {
        code: 10101,
        message: "Invalid repo name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/",
        documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10101",
        source: { pointer: "/name" },
      },
    ]);
    const missing = await call("GET", "/namespaces/default/repos/nope-404");
    expect(missing.json!.errors).toEqual([
      {
        code: 10200,
        message: "Repository not found",
        documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
      },
    ]);
    const ttl = await call("POST", "/namespaces/default/tokens", { repo: "x", ttl: 1 });
    expect(ttl.json!.errors[0]).toMatchObject({
      message: "ttl must be between 60 and 31536000 seconds",
      source: { pointer: "/ttl" },
    });
  });

  it("rejects malformed JSON bodies", async () => {
    expect((await call("POST", "/namespaces", "{oops")).json!.errors[0].code).toBe(10100);
    expect((await call("POST", "/namespaces", "[1]")).json!.errors[0].code).toBe(10100);
  });
});

describe("namespaces", () => {
  it("creates, lists, gets, and deletes", async () => {
    const c = await call("POST", "/namespaces", { namespace: "eu-ns", jurisdiction: "eu" });
    expect(c.json!.result).toMatchObject({ namespace: "eu-ns", jurisdiction: "eu", repo_count: 0 });
    expect(Object.keys(c.json!.result).toSorted()).toEqual([
      "created_at",
      "jurisdiction",
      "namespace",
      "repo_count",
      "updated_at",
    ]);
    const plain = await call("POST", "/namespaces", { namespace: "plain-ns" });
    expect(plain.json!.result.jurisdiction).toBe("unrestricted");
    const list = await call("GET", "/namespaces?limit=100");
    expect(list.json!.result.map((n: any) => n.namespace)).toContain("eu-ns");
    expect(list.json!.result_info).toMatchObject({ page: 1, per_page: 100, total_pages: 1 });
    expect((await call("GET", "/namespaces/eu-ns")).json!.result.namespace).toBe("eu-ns");
    expect((await call("POST", "/namespaces", { namespace: "eu-ns" })).status).toBe(409);
    expect(c.status).toBe(201);
    const del = await call("DELETE", "/namespaces/eu-ns");
    expect(del.status).toBe(204);
    expect(await del.res.text()).toBe("");
    expect((await call("GET", "/namespaces/eu-ns")).status).toBe(404);
  });
});

describe("repos", () => {
  it("creates with the documented result shape", async () => {
    const r = await call("POST", "/namespaces/default/repos", {
      name: "shape",
      description: "d",
      default_branch: "trunk",
      read_only: false,
    });
    expect(Object.keys(r.json!.result).toSorted()).toEqual([
      "default_branch",
      "description",
      "id",
      "name",
      "remote",
      "token",
    ]);
    expect(r.json!.result).toMatchObject({
      name: "shape",
      description: "d",
      default_branch: "trunk",
      remote: `${srv.url}/git/default/shape.git`,
    });
  });

  it("gets with the documented RepoWithRemote shape", async () => {
    await createRepo("getme");
    const r = await call("GET", "/namespaces/default/repos/getme");
    expect(Object.keys(r.json!.result).toSorted()).toEqual([
      "created_at",
      "default_branch",
      "description",
      "id",
      "last_push_at",
      "name",
      "read_only",
      "remote",
      "source",
      "updated_at",
    ]);
  });

  it("validates create input", async () => {
    expect((await call("POST", "/namespaces/default/repos", { name: "-x" })).json!.errors[0].code).toBe(10101);
    expect(
      (await call("POST", "/namespaces/default/repos", { name: "ok1", read_only: "yes" })).json!.errors[0].code,
    ).toBe(10100);
    expect(
      (await call("POST", "/namespaces/default/repos", { name: "ok1", description: 5 })).json!.errors[0].code,
    ).toBe(10100);
    await createRepo("dup");
    const d = await call("POST", "/namespaces/default/repos", { name: "dup" });
    expect(d.status).toBe(409);
    expect(d.json!.errors[0].code).toBe(10201);
  });

  it("lists with cursor pagination and search", async () => {
    await call("POST", "/namespaces", { namespace: "listing" });
    for (const n of ["l1", "l2", "l3"]) {
      clock += 1000;
      await call("POST", "/namespaces/listing/repos", { name: n });
    }
    const p1 = await call("GET", "/namespaces/listing/repos?limit=2");
    expect(p1.json!.result.map((r: any) => r.name)).toEqual(["l3", "l2"]);
    expect(p1.json!.result[0].remote).toContain("/git/listing/l3.git");
    expect(p1.json!.result_info).toEqual({ cursor: expect.any(String), per_page: 2, count: 2 });
    expect(p1.json!.result[0].status).toBe("ready");
    const p2 = await call("GET", `/namespaces/listing/repos?limit=2&cursor=${p1.json!.result_info.cursor}`);
    expect(p2.json!.result.map((r: any) => r.name)).toEqual(["l1"]);
    expect(p2.json!.result_info).toEqual({ page: 1, per_page: 2, total_pages: 2, count: 1, total_count: 3 });
    const none = await call("GET", "/namespaces/no-such-ns/repos");
    expect(none.json).toMatchObject({
      success: true,
      result: [],
      result_info: { page: 1, per_page: 50, total_pages: 0, count: 0, total_count: 0 },
    });
    const s = await call("GET", "/namespaces/listing/repos?search=2&sort=name&direction=asc");
    expect(s.json!.result.map((r: any) => r.name)).toEqual(["l2"]);
    expect((await call("GET", "/namespaces/listing/repos?limit=abc")).status).toBe(400);
  });

  it("deletes with 202 and {id}", async () => {
    const { id } = await createRepo("gone");
    const r = await call("DELETE", "/namespaces/default/repos/gone");
    expect(r.status).toBe(202);
    expect(r.json!.result).toEqual({ id });
    const again = await call("DELETE", "/namespaces/default/repos/gone");
    expect(again.status).toBe(202);
    expect(again.json!.result).toEqual({ id });
    expect((await call("DELETE", "/namespaces/default/repos/never-was")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/gone")).json!.errors[0].code).toBe(10200);
  });
});

describe("git over HTTP", () => {
  it("pushes with Bearer, clones with Basic, and leaves last_push_at alone (live)", async () => {
    const { remote, token } = await createRepo("gitflow");
    const w = await work();
    await w.commit("init", { "README.md": "hello\n" });
    await w.run([...bearer(token), "push", "-q", remote, "main"]);

    const secret = token.split("?expires=")[0];
    const basicRemote = remote.replace("http://", `http://x:${secret}@`);
    const clone = join(tmp.path, "gitflow-clone");
    await git(["clone", "-q", basicRemote, clone]).then((r) => expect(r.code, r.stderr).toBe(0));

    const info = await call("GET", "/namespaces/default/repos/gitflow");
    expect(info.json!.result.last_push_at).toBeNull();
    const types = srv.store.events.history.map((e) => e.type);
    expect(types).toContain("cf.artifacts.repo.pushed");
    expect(types).toContain("cf.artifacts.repo.cloned");
  });

  it("emits fetched for an incremental fetch", async () => {
    const { remote, token } = await createRepo("fetchy");
    const w = await work();
    await w.commit("one");
    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    const clone = join(tmp.path, "fetchy-clone");
    await git([...bearer(token), "clone", "-q", remote, clone]);
    await w.commit("two");
    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    srv.store.events.history.length = 0;
    const r = await git(["-C", clone, ...bearer(token), "fetch", "-q"]);
    expect(r.code, r.stderr).toBe(0);
    expect(srv.store.events.history.map((e) => e.type)).toEqual(["cf.artifacts.repo.fetched"]);
  });

  it("requires a token and the right scope", async () => {
    const { remote, token } = await createRepo("authz");
    const w = await work();
    await w.commit("init");
    const noAuth = await git(["-C", w.dir, "push", remote, "main"]);
    expect(noAuth.code).not.toBe(0);
    expect(noAuth.stderr).toMatch(/401|Authentication|could not read Username/i);

    const read = (await call("POST", "/namespaces/default/tokens", { repo: "authz", scope: "read", ttl: 600 })).json!
      .result;
    const denied = await git(["-C", w.dir, ...bearer(read.plaintext), "push", remote, "main"]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain("403");
    expect(denied.stderr).toContain("remote: Insufficient permissions");

    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    const ls = await git([...bearer(read.plaintext), "ls-remote", remote]);
    expect(ls.code).toBe(0);
  });

  it("rejects expired and revoked tokens", async () => {
    const { remote } = await createRepo("expiry");
    const t = (await call("POST", "/namespaces/default/tokens", { repo: "expiry", scope: "read", ttl: 60 })).json!
      .result;
    expect((await git([...bearer(t.plaintext), "ls-remote", remote])).code).toBe(0);
    clock += 61_000;
    const expired = await git([...bearer(t.plaintext), "ls-remote", remote]);
    expect(expired.code).not.toBe(0);
    expect(expired.stderr).toContain("403");
    expect(expired.stderr).toContain("remote: Invalid or expired token");

    const t2 = (await call("POST", "/namespaces/default/tokens", { repo: "expiry", scope: "read" })).json!.result;
    expect((await call("DELETE", `/namespaces/default/tokens/${t2.id}`)).json!.result).toEqual({ id: t2.id });
    expect((await git([...bearer(t2.plaintext), "ls-remote", remote])).code).not.toBe(0);
    const again = await call("DELETE", `/namespaces/default/tokens/${t2.id}`);
    expect(again.status).toBe(200);
    expect(again.json!.result).toEqual({ id: t2.id });
    expect((await call("DELETE", "/namespaces/default/tokens/zzzzzzzzzzzzzzzz")).status).toBe(404);
  });

  it("accepts a write-token push to a read-only repo, as live does", async () => {
    const { remote, token } = await createRepo("frozen", { read_only: true });
    const w = await work();
    await w.commit("init");
    const r = await git(["-C", w.dir, ...bearer(token), "push", remote, "main"]);
    expect(r.code, r.stderr).toBe(0);
  });

  it("returns 404 for unknown repos and dumb HTTP paths", async () => {
    const r1 = await fetch(`${srv.url}/git/default/nothing.git/info/refs?service=git-upload-pack`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${srv.url}/git/default/gitflow.git/HEAD`);
    expect(r2.status).toBe(404);
  });

  it("serves protocol v2 for fetch and v0 for push", async () => {
    const { remote, token } = await createRepo("proto");
    const w = await work();
    await w.commit("init");
    const push = await git(["-C", w.dir, "-c", "protocol.version=2", ...bearer(token), "push", remote, "main"], {
      env: { GIT_TRACE_PACKET: "1" },
    });
    expect(push.code, push.stderr).toBe(0);
    expect(push.stderr).not.toMatch(/version 2/);
    const fetchV2 = await git(["-c", "protocol.version=2", ...bearer(token), "ls-remote", remote], {
      env: { GIT_TRACE_PACKET: "1" },
    });
    expect(fetchV2.code).toBe(0);
    expect(fetchV2.stderr).toMatch(/version 2/);
  });

  it("honours --filter over protocol v2 and ignores it over v0, as live", async () => {
    const { remote, token } = await createRepo("partial");
    const w = await work();
    await w.commit("init", { "big.txt": "x".repeat(10_000), "small.txt": "s" });
    await w.run([...bearer(token), "push", "-q", remote, "main"]);

    const v2 = join(tmp.path, "partial-v2");
    const r2 = await git([
      "-c",
      "protocol.version=2",
      ...bearer(token),
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      remote,
      v2,
    ]);
    expect(r2.code, r2.stderr).toBe(0);
    expect(r2.stderr).not.toContain("filtering not recognized");
    expect((await git(["-C", v2, "config", "--get", "remote.origin.promisor"])).stdout.toString().trim()).toBe("true");
    const blobs = await git(["-C", v2, "rev-list", "--objects", "--all", "--missing=print"]);
    expect(blobs.stdout.toString()).toMatch(/^\?[0-9a-f]{40}$/m);

    const v0 = join(tmp.path, "partial-v0");
    const r0 = await git([
      "-c",
      "protocol.version=0",
      ...bearer(token),
      "clone",
      "-q",
      "--filter=blob:none",
      remote,
      v0,
    ]);
    expect(r0.code, r0.stderr).toBe(0);
    expect(r0.stderr).toContain("filtering not recognized by server");
  });

  it("fetches one blob on demand from a blobless clone, as ArtifactFS needs", async () => {
    const { remote, token } = await createRepo("lazy");
    const w = await work();
    await w.commit("init", { "a.txt": "aaa\n", "b.txt": "bbb\n", "c.txt": "ccc\n" });
    await w.run([...bearer(token), "push", "-q", remote, "main"]);

    const dir = join(tmp.path, "lazy-clone");
    const clone = await git([
      "-c",
      "protocol.version=2",
      ...bearer(token),
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      remote,
      dir,
    ]);
    expect(clone.code, clone.stderr).toBe(0);
    await git(["-C", dir, "config", "http.extraHeader", `Authorization: Bearer ${token}`]);
    const missing = async () =>
      (await git(["-C", dir, "rev-list", "--objects", "--all", "--missing=print"])).stdout
        .toString()
        .split("\n")
        .filter((l) => l.startsWith("?")).length;

    expect(await missing()).toBe(3);
    const blob = (await git(["-C", dir, "rev-parse", "HEAD:b.txt"])).stdout.toString().trim();
    const read = await git(["-C", dir, "-c", "protocol.version=2", "cat-file", "-p", blob]);
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout.toString()).toBe("bbb\n");
    expect(await missing()).toBe(2);
  });

  it("advertises the live service's capabilities, not git's", async () => {
    const { remote, token } = await createRepo("caps");
    const w = await work();
    await w.commit("init");
    await w.run([...bearer(token), "push", "-q", remote, "main"]);
    const adv = async (service: string, proto?: string) => {
      const res = await fetch(`${remote}/info/refs?service=${service}`, {
        headers: { authorization: `Bearer ${token}`, ...(proto ? { "git-protocol": proto } : {}) },
      });
      return (await res.text()).replace(/[0-9a-f]{40}/g, "<sha>");
    };
    expect(await adv("git-upload-pack")).toContain(
      "HEAD\0agent=artifacts-local object-format=sha1 multi_ack multi_ack_detailed no-done side-band side-band-64k shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress symref=HEAD:refs/heads/main\n",
    );
    expect(await adv("git-receive-pack")).toContain(
      // HEAD leads, carrying the capabilities (the hash before it sits behind a pkt-line length).
      " HEAD\0report-status delete-refs ofs-delta side-band-64k symref=HEAD:refs/heads/main\n",
    );
    expect(await adv("git-upload-pack", "version=2")).toBe(
      "001e# service=git-upload-pack\n0000000eversion 2\n001aagent=artifacts-local\n0013ls-refs=unborn\n0026fetch=shallow filter sideband-all\n0017object-format=sha1\n0000",
    );
  });

  it("refuses git push --atomic and push options, as live does", async () => {
    const { remote, token } = await createRepo("atomic");
    const w = await work();
    await w.commit("init");
    await w.run(["branch", "other"]);
    const atomic = await git(["-C", w.dir, ...bearer(token), "push", "--atomic", remote, "main", "other"]);
    expect(atomic.code).not.toBe(0);
    expect(atomic.stderr).toContain("the receiving end does not support --atomic push");
    const options = await git(["-C", w.dir, ...bearer(token), "push", "-o", "ci.skip", remote, "main"]);
    expect(options.code).not.toBe(0);
    expect(options.stderr).toContain("the receiving end does not support push options");
    const plain = await git(["-C", w.dir, ...bearer(token), "push", "-q", remote, "main", "other"]);
    expect(plain.code, plain.stderr).toBe(0);
  });

  it("supports branch deletion and force push", async () => {
    const { remote, token } = await createRepo("rewrite");
    const w = await work();
    await w.commit("one");
    await w.run(["branch", "topic"]);
    await w.run([...bearer(token), "push", "-q", remote, "main", "topic"]);
    await w.run([...bearer(token), "push", "-q", remote, ":topic"]);
    await w.run(["commit", "-q", "--amend", "--allow-empty", "-m", "one, rewritten"]);
    await w.run([...bearer(token), "push", "-q", "--force", remote, "main"]);
    const logRes = await call("GET", "/namespaces/default/repos/rewrite/log");
    expect(logRes.json!.result.map((c: any) => c.message)).toEqual(["one, rewritten"]);
    const pushed = srv.store.events.history
      .filter((e) => e.type === "cf.artifacts.repo.pushed")
      .map((e) => e.payload.ref);
    expect(pushed).toEqual(["refs/heads/main", "refs/heads/topic", "refs/heads/topic", "refs/heads/main"]);
  });
});

describe("repo content routes", () => {
  let head: string;
  let tree: string;
  beforeAll(async () => {
    const { remote, token } = await createRepo("content");
    const w = await work();
    await w.commit("init", { "README.md": "# readme\n", "docs/guide.md": "guide\n" });
    await w.write("bin.dat", Buffer.from([0, 1, 2, 255]));
    head = await w.commit("add binary");
    await w.run(["checkout", "-q", "-b", "feature/x"]);
    await w.commit("on feature", { "f.txt": "f\n" });
    await w.run([...bearer(token), "push", "-q", remote, "main", "feature/x"]);
    tree = (await call("GET", `/namespaces/default/repos/content/commit/${head}`)).json!.result.treeHash;
  });

  it("reads log with ref, limit, offset", async () => {
    const all = await call("GET", "/namespaces/default/repos/content/log");
    expect(all.json!.result.map((c: any) => c.message)).toEqual(["add binary", "init"]);
    expect(Object.keys(all.json!.result[0]).toSorted()).toEqual([
      "author",
      "authoredAt",
      "committedAt",
      "committer",
      "hash",
      "message",
      "parents",
      "treeHash",
    ]);
    const one = await call("GET", "/namespaces/default/repos/content/log?ref=feature/x&limit=1&offset=1");
    expect(one.json!.result.map((c: any) => c.message)).toEqual(["add binary"]);
    expect((await call("GET", "/namespaces/default/repos/content/log?ref=nope")).json!.result).toEqual([]);
  });

  it("reads commits and trees, with 404 and 400 errors", async () => {
    const c = await call("GET", `/namespaces/default/repos/content/commit/${head}`);
    expect(c.json!.result).toMatchObject({ hash: head, message: "add binary" });
    const t = await call("GET", `/namespaces/default/repos/content/tree/${tree}`);
    expect(t.json!.result.map((e: any) => e.name).toSorted()).toEqual(["README.md", "bin.dat", "docs"]);
    expect((await call("GET", `/namespaces/default/repos/content/commit/${"0".repeat(40)}`)).status).toBe(404);
    expect((await call("GET", `/namespaces/default/repos/content/tree/${"0".repeat(40)}`)).status).toBe(404);
    const bad = await call("GET", "/namespaces/default/repos/content/commit/XYZ");
    expect(bad.status).toBe(400);
    expect(bad.json!.errors[0].code).toBe(10100);
  });

  it("returns blob and file bytes as octet-stream", async () => {
    const entries = (await call("GET", `/namespaces/default/repos/content/tree/${tree}`)).json!.result;
    const readme = entries.find((e: any) => e.name === "README.md");
    const b = await call("GET", `/namespaces/default/repos/content/blob/${readme.hash}`);
    expect(b.type).toBe("application/octet-stream");
    expect(await b.res.text()).toBe("# readme\n");
    const f = await call("GET", "/namespaces/default/repos/content/file?ref=main&path=docs/guide.md");
    expect(f.type).toBe("application/octet-stream");
    expect(await f.res.text()).toBe("guide\n");
    const missing = await call("GET", "/namespaces/default/repos/content/file?ref=main&path=nope");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ success: false, errors: [{ code: 10200, message: "File not found" }] });
    expect((await call("GET", "/namespaces/default/repos/content/file?ref=main")).status).toBe(400);
    expect((await call("GET", `/namespaces/default/repos/content/blob/${"0".repeat(40)}`)).status).toBe(404);
  });

  it("returns raw files with a sniffed type; refs containing a slash are not addressable", async () => {
    const txt = await call("GET", "/namespaces/default/repos/content/raw/main/README.md");
    expect(txt.type).toBe("text/plain; charset=utf-8");
    const bin = await call("GET", "/namespaces/default/repos/content/raw/main/bin.dat");
    expect(bin.type).toBe("application/octet-stream");
    expect(Buffer.from(await bin.res.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
    const feat = await call("GET", "/namespaces/default/repos/content/raw/feature/x/f.txt");
    expect(feat.status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/raw/main")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/raw/nope/x")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/raw/main/none.txt")).status).toBe(404);
  });

  it("rejects malformed content paths", async () => {
    expect((await call("GET", "/namespaces/default/repos/content/commit")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/log/extra")).status).toBe(404);
    expect((await call("POST", "/namespaces/default/repos/content/log")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/tree")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/blob")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/file/x")).status).toBe(404);
    expect((await call("GET", "/namespaces/default/repos/content/tokens/x")).status).toBe(404);
  });
});

describe("tokens routes", () => {
  it("creates with the documented shape and lists with offset pagination", async () => {
    await createRepo("toks");
    const t = await call("POST", "/namespaces/default/tokens", { repo: "toks", scope: "read", ttl: 3600 });
    expect(t.status).toBe(201);
    expect(Object.keys(t.json!.result).toSorted()).toEqual(["expires_at", "id", "plaintext", "scope"]);
    expect(t.json!.result.plaintext).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);

    const list = await call("GET", "/namespaces/default/repos/toks/tokens?per_page=1");
    expect(list.json!.result).toHaveLength(1);
    expect(Object.keys(list.json!.result[0]).toSorted()).toEqual(["created_at", "expires_at", "id", "scope", "state"]);
    expect(list.json!.result_info).toEqual({ page: 1, per_page: 1, total_pages: 2, count: 1, total_count: 2 });

    await call("DELETE", `/namespaces/default/tokens/${t.json!.result.id}`);
    expect((await call("GET", "/namespaces/default/repos/toks/tokens")).json!.result).toHaveLength(1);
    expect((await call("GET", "/namespaces/default/repos/toks/tokens?state=revoked")).json!.result).toHaveLength(1);
    expect((await call("GET", "/namespaces/default/repos/toks/tokens?state=all")).json!.result).toHaveLength(2);
  });

  it("validates token parameters", async () => {
    await createRepo("tokv");
    expect((await call("POST", "/namespaces/default/tokens", { scope: "read" })).json!.errors[0].code).toBe(10100);
    expect((await call("POST", "/namespaces/default/tokens", { repo: "tokv", ttl: 1 })).json!.errors[0].code).toBe(
      10103,
    );
    expect((await call("POST", "/namespaces/default/tokens", { repo: "ghost" })).status).toBe(404);
    for (const qs of ["state=bogus", "per_page=0", "per_page=101", "page=0"]) {
      expect((await call("GET", `/namespaces/default/repos/tokv/tokens?${qs}`)).status, qs).toBe(400);
    }
  });
});

describe("fork and import routes", () => {
  it("forks every branch, with objects in the result, ignoring default_branch_only", async () => {
    const { remote, token } = await createRepo("upstream", { description: "up" });
    const w = await work();
    await w.commit("init");
    await w.run(["branch", "side"]);
    await w.run([...bearer(token), "push", "-q", remote, "main", "side"]);

    const f = await call("POST", "/namespaces/default/repos/upstream/fork", { name: "downstream" });
    expect(f.json!.result).toMatchObject({ name: "downstream", description: null, default_branch: "main" });
    expect(f.json!.result.objects).toBeGreaterThan(0);
    const info = await call("GET", "/namespaces/default/repos/downstream");
    expect(info.json!.result.source).toBe("artifacts:default/upstream");
    const ls = await git([...bearer(f.json!.result.token), "ls-remote", f.json!.result.remote]);
    expect(ls.stdout.toString()).toContain("refs/heads/side");

    const all = await call("POST", "/namespaces/default/repos/upstream/fork", {
      name: "downstream-all",
      default_branch_only: true,
    });
    const ls2 = await git([...bearer(all.json!.result.token), "ls-remote", all.json!.result.remote]);
    expect(ls2.stdout.toString()).toContain("refs/heads/side");

    expect((await call("POST", "/namespaces/default/repos/upstream/fork", { name: "downstream" })).status).toBe(409);
    expect((await call("POST", "/namespaces/default/repos/upstream/fork", {})).json!.errors[0].code).toBe(10101);
  });

  it("rejects non-HTTPS imports", async () => {
    const r = await call("POST", "/namespaces/default/repos/imp/import", { url: "file:///etc" });
    expect(r.status).toBe(400);
    expect(r.json!.errors[0].code).toBe(10100);
    expect((await call("POST", "/namespaces/default/repos/imp/import", { url: "https://x", depth: "1" })).status).toBe(
      400,
    );
  });

  it("imports from a local path when insecure import is allowed", async () => {
    const loose = await startServer({ dataDir: join(tmp.path, "loose"), allowInsecureImport: true });
    try {
      const w = await work();
      await w.commit("upstream commit");
      const res = await fetch(`${loose.url}/client/v4/accounts/a/artifacts/namespaces/default/repos/mirror/import`, {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ url: w.dir, depth: 1 }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(201);
      expect(Object.keys(body.result).toSorted()).toEqual([
        "default_branch",
        "description",
        "id",
        "name",
        "remote",
        "token",
      ]);
    } finally {
      await loose.close();
    }
  });

  it("returns 409 for a repo that is still forking", async () => {
    const slow = await startServer({ dataDir: join(tmp.path, "slow"), asyncDelayMs: 400 });
    try {
      const base = `${slow.url}/client/v4/accounts/a/artifacts/namespaces/default/repos`;
      const h = { authorization: "Bearer x", "content-type": "application/json" };
      await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ name: "src" }) });
      const pending = fetch(`${base}/src/fork`, { method: "POST", headers: h, body: JSON.stringify({ name: "dst" }) });
      await new Promise((r) => setTimeout(r, 150));
      const mid = await fetch(`${base}/dst`, { headers: h });
      expect(mid.status).toBe(409);
      expect(((await mid.json()) as any).errors[0].code).toBe(10303);
      const git409 = await fetch(`${slow.url}/git/default/dst.git/info/refs?service=git-upload-pack`);
      expect(git409.status).toBe(409);
      expect((await pending).status).toBe(201);
    } finally {
      await slow.close();
    }
  });
});

describe("local admin routes", () => {
  it("serves health and filtered event history", async () => {
    expect(await (await fetch(`${srv.url}/__local/health`)).json()).toEqual({ ok: true });
    await createRepo("evts");
    const all = (await (await fetch(`${srv.url}/__local/events`)).json()) as any[];
    expect(all.map((e) => e.type)).toEqual(["cf.artifacts.repo.created", "cf.artifacts.repo.token.created"]);
    const only = (await (await fetch(`${srv.url}/__local/events?type=cf.artifacts.repo.created`)).json()) as any[];
    expect(only).toHaveLength(1);
    await fetch(`${srv.url}/__local/events`, { method: "DELETE" });
    expect(await (await fetch(`${srv.url}/__local/events`)).json()).toEqual([]);
    expect((await fetch(`${srv.url}/__local/other`)).status).toBe(404);
  });

  it("posts events to a webhook", async () => {
    const received: any[] = [];
    const { createServer } = await import("node:http");
    const hook = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        received.push(JSON.parse(b));
        res.end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const port = (hook.address() as { port: number }).port;
    const s = await startServer({ dataDir: join(tmp.path, "hooked"), webhookUrl: `http://127.0.0.1:${port}/` });
    try {
      await fetch(`${s.url}/client/v4/accounts/a/artifacts/namespaces/default/repos`, {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ name: "hooked" }),
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(received.map((e) => e.type)).toContain("cf.artifacts.repo.created");
    } finally {
      await s.close();
      hook.close();
    }
  });
});
