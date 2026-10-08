import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { WorkTree, tempDir } from "../helpers.ts";
import { LIVE, type Target, openTarget } from "./target.ts";

// Behaviour every target must share. Keep assertions to what the docs promise; anything the
// emulator guessed (see SPEC.md "guess") is checked here so a live run exposes the drift.

let t: Target;
let tmp: Awaited<ReturnType<typeof tempDir>>;
const suffix = Math.random().toString(36).slice(2, 7);
const repoName = (s: string) => `c-${s}-${suffix}`;

beforeAll(async () => {
  t = await openTarget();
  tmp = await tempDir();
}, 60_000);

afterAll(async () => {
  await t?.close();
  await tmp?.cleanup();
}, 120_000);

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${t.base}${path}`, {
    method,
    headers: t.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("json") ? ((await res.json()) as any) : null;
  return { status: res.status, type, json, res };
}

const bearer = (token: string) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

async function created(name: string, extra: Record<string, unknown> = {}) {
  const r = await api("POST", "/repos", { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.result as { id: string; remote: string; token: string; default_branch: string };
}

async function seed(remote: string, token: string, branches = ["main"]): Promise<WorkTree> {
  const w = await WorkTree.init(join(tmp.path, `w-${Math.random().toString(36).slice(2)}`));
  await w.commit("first", { "README.md": "# contract\n" });
  await w.commit("second", { "src/a.txt": "a\n" });
  for (const b of branches.slice(1)) await w.run(["branch", b]);
  const r = await git(["-C", w.dir, ...bearer(token), "push", "-q", remote, ...branches]);
  expect(r.code, r.stderr).toBe(0);
  return w;
}

describe(`contract (${LIVE ? "live" : "local"})`, () => {
  it("create returns the documented shape and a token in the documented format", async () => {
    const r = await created(repoName("shape"), { description: "contract" });
    expect(Object.keys(r).toSorted()).toEqual(["default_branch", "description", "id", "name", "remote", "token"]);
    expect(r.default_branch).toBe("main");
    expect(r.token).toMatch(/^art_v2_x_[0-9a-f]{40}\?expires=\d+$/);
    expect(r.remote).toMatch(new RegExp(`/git/${t.namespace}/${repoName("shape")}\\.git$`));
  });

  it("get returns RepoWithRemote", async () => {
    await created(repoName("get"));
    const r = await api("GET", `/repos/${repoName("get")}`);
    expect(r.json.success).toBe(true);
    expect(Object.keys(r.json.result).toSorted()).toEqual([
      "created_at", "default_branch", "description", "id", "last_push_at", "name", "read_only", "remote", "source", "updated_at",
    ]);
    expect(r.json.result.last_push_at).toBeNull();
  });

  it("errors use the v4 envelope with documented codes", async () => {
    const missing = await api("GET", `/repos/${repoName("missing")}`);
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ success: false, result: null, errors: [{ code: 10200 }] });

    await created(repoName("dup"));
    const dup = await api("POST", "/repos", { name: repoName("dup") });
    expect(dup.status).toBe(409);
    expect(dup.json.errors[0].code).toBe(10201);

    const bad = await api("POST", "/repos", { name: "-bad" });
    expect(bad.json.errors[0].code).toBe(10101);

    const ttl = await api("POST", "/tokens", { repo: repoName("dup"), ttl: 10 });
    expect(ttl.json.errors[0].code).toBe(10103);
  });

  it("git push with a write token, clone with a read token, push with read is refused", async () => {
    const r = await created(repoName("git"));
    await seed(r.remote, r.token);
    const read = (await api("POST", "/tokens", { repo: repoName("git"), scope: "read", ttl: 600 })).json.result;
    expect(Object.keys(read).toSorted()).toEqual(["expires_at", "id", "plaintext", "scope"]);

    const dir = join(tmp.path, `clone-${suffix}`);
    const clone = await git([...bearer(read.plaintext), "clone", "-q", r.remote, dir]);
    expect(clone.code, clone.stderr).toBe(0);
    const w = new WorkTree(dir);
    await w.commit("from reader");
    const denied = await git(["-C", dir, ...bearer(read.plaintext), "push", r.remote, "main"]);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/403/);

    // Live (2026-10-08) never set last_push_at after a push.
    const info = await api("GET", `/repos/${repoName("git")}`);
    expect(info.json.result.last_push_at).toBeNull();
  });

  it("accepts Basic auth with the token secret as the password", async () => {
    const r = await created(repoName("basic"));
    await seed(r.remote, r.token);
    const secret = r.token.split("?expires=")[0]!;
    const url = new URL(r.remote);
    url.username = "x";
    url.password = secret;
    const ls = await git(["ls-remote", url.toString()]);
    expect(ls.code, ls.stderr).toBe(0);
    expect(ls.stdout.toString()).toContain("refs/heads/main");
  });

  it("rejects git without a token", async () => {
    const r = await created(repoName("noauth"));
    const ls = await git(["ls-remote", r.remote]);
    expect(ls.code).not.toBe(0);
  });

  it("fork copies every branch, ignores default_branch_only, and records its source", async () => {
    const r = await created(repoName("fsrc"));
    await seed(r.remote, r.token, ["main", "side"]);
    const f = await api("POST", `/repos/${repoName("fsrc")}/fork`, { name: repoName("fdst") });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    expect(f.json.result.objects).toEqual(expect.any(Number));
    const ls = await git([...bearer(f.json.result.token), "ls-remote", f.json.result.remote]);
    expect(ls.stdout.toString()).toContain("refs/heads/main");
    expect(ls.stdout.toString()).toContain("refs/heads/side");
    expect(f.json.result.description).toBeNull();
    const info = await api("GET", `/repos/${repoName("fdst")}`);
    expect(info.json.result.source).toBe(`artifacts:${t.namespace}/${repoName("fsrc")}`);

    const all = await api("POST", `/repos/${repoName("fsrc")}/fork`, { name: repoName("fall"), default_branch_only: true });
    const ls2 = await git([...bearer(all.json.result.token), "ls-remote", all.json.result.remote]);
    expect(ls2.stdout.toString()).toContain("refs/heads/side");
  });

  it("serves content routes", async () => {
    const r = await created(repoName("content"));
    await seed(r.remote, r.token);
    const log = await api("GET", `/repos/${repoName("content")}/log?ref=main&limit=10`);
    expect(log.status).toBe(200);
    expect(log.json.result).toHaveLength(2);

    const file = await api("GET", `/repos/${repoName("content")}/file?ref=main&path=README.md`);
    expect(file.status).toBe(200);
    expect(file.type).toBe("application/octet-stream");
    expect(await file.res.text()).toBe("# contract\n");

    const missing = await api("GET", `/repos/${repoName("content")}/file?ref=main&path=nope`);
    expect(missing.status).toBe(404);
    expect(missing.json.errors[0].code).toBe(10200);

    const raw = await api("GET", `/repos/${repoName("content")}/raw/main/README.md`);
    expect(raw.status).toBe(200);
    expect(await raw.res.text()).toBe("# contract\n");
  });

  it("log entries use the camelCase commit shape", async () => {
    const r = await created(repoName("logshape"));
    await seed(r.remote, r.token);
    const log = await api("GET", `/repos/${repoName("logshape")}/log`);
    expect(Object.keys(log.json.result[0]).toSorted()).toEqual([
      "author", "authoredAt", "committedAt", "committer", "hash", "message", "parents", "treeHash",
    ]);
  });

  it("lists tokens with offset pagination", async () => {
    await created(repoName("toks"));
    await api("POST", "/tokens", { repo: repoName("toks"), scope: "read", ttl: 600 });
    const list = await api("GET", `/repos/${repoName("toks")}/tokens?state=all&per_page=30&page=1`);
    expect(list.status).toBe(200);
    expect(list.json.result_info).toMatchObject({ page: 1, per_page: 30, total_pages: 1, count: 2, total_count: 2 });
    expect(Object.keys(list.json.result[0]).toSorted()).toEqual(["created_at", "expires_at", "id", "scope", "state"]);
  });

  it("revokes tokens by id", async () => {
    const r = await created(repoName("revoke"));
    await seed(r.remote, r.token);
    const tok = (await api("POST", "/tokens", { repo: repoName("revoke"), scope: "read", ttl: 600 })).json.result;
    const del = await api("DELETE", `/tokens/${tok.id}`);
    expect(del.status).toBe(200);
    expect(del.json.result).toEqual({ id: tok.id });
    const ls = await git([...bearer(tok.plaintext), "ls-remote", r.remote]);
    expect(ls.code).not.toBe(0);
  });

  // Surprising, but observed live on 2026-10-08: read_only does not block a write-token push.
  it("accepts a write-token push to a read-only repo", async () => {
    const r = await created(repoName("ro"), { read_only: true });
    const w = await WorkTree.init(join(tmp.path, `ro-${suffix}`));
    await w.commit("x");
    const push = await git(["-C", w.dir, ...bearer(r.token), "push", r.remote, "main"]);
    expect(push.code, push.stderr).toBe(0);
  });

  it("deletes with 202 Accepted and {id}", async () => {
    const r = await created(repoName("del"));
    const d = await api("DELETE", `/repos/${repoName("del")}`);
    expect(d.status).toBe(202);
    expect(d.json.result).toEqual({ id: r.id });
  });
});
