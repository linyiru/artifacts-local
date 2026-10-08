import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as isogit from "isomorphic-git";
import isohttp from "isomorphic-git/http/web";
import * as fs from "node:fs";
import { parsePkts } from "../../src/capabilities.ts";

// One fixed sequence of REST calls and git commands, run against any Artifacts target.
// `npm run record` runs it against the live service and saves the result as a fixture;
// test/fixtures.test.ts runs it against the emulator and compares.

export interface Target {
  /** .../accounts/<id>/artifacts */
  account: string;
  token: string;
  namespace: string;
}

export type Exchange =
  | {
      kind: "http";
      label: string;
      method: string;
      path: string;
      request: unknown;
      status: number;
      contentType: string;
      body: unknown;
    }
  | { kind: "git"; label: string; code: number; remote: string[]; stdout: string };

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "probe",
  GIT_AUTHOR_EMAIL: "probe@example.com",
  GIT_COMMITTER_NAME: "probe",
  GIT_COMMITTER_EMAIL: "probe@example.com",
  LC_ALL: "C",
};

const auth = (token: string) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

export async function runScenario(t: Target, opts: { skipNetworkImports?: boolean } = {}): Promise<Exchange[]> {
  const out: Exchange[] = [];
  const BASE = `${t.account}/namespaces/${t.namespace}`;
  const work = mkdtempSync(join(tmpdir(), "artifacts-record-"));

  async function api(label: string, method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed: unknown = buf.length ? `bytes:${buf.toString("base64")}` : "";
    if (contentType.includes("json")) {
      try {
        parsed = JSON.parse(buf.toString());
      } catch {}
    } else if (contentType.startsWith("text/")) {
      parsed = buf.toString();
    }
    out.push({
      kind: "http",
      label,
      method,
      path: url.slice(t.account.length),
      request: body ?? null,
      status: res.status,
      contentType,
      body: parsed,
    });
    return { status: res.status, json: parsed as any };
  }

  // Async on purpose: the emulator under test may run in this same process, and a synchronous
  // spawn would block the event loop it needs to answer git.
  async function git(label: string, args: string[]) {
    const r = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("git", args, { env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    });
    const remote = r.stderr
      .split("\n")
      .filter((l) =>
        /^remote: |filtering not recognized|could not read Username|returned error: \d+|does not support/.test(l),
      )
      .map((l) =>
        l.replace(/unable to access '[^']*'/, "unable to access '<remote>'").replace(/for '[^']*'/, "for '<host>'"),
      );
    out.push({ kind: "git", label, code: r.status, remote, stdout: r.stdout });
    return r;
  }

  try {
    // namespaces
    await api("ns create", "POST", `${t.account}/namespaces`, { namespace: t.namespace });
    await api("ns create dup", "POST", `${t.account}/namespaces`, { namespace: t.namespace });
    await api("ns get", "GET", BASE);
    await api("ns get missing", "GET", `${t.account}/namespaces/${t.namespace}-missing`);
    await api("ns create bad name", "POST", `${t.account}/namespaces`, { namespace: "-x" });

    // repos
    const c = await api("repo create", "POST", `${BASE}/repos`, {
      name: "base",
      description: "probe",
      default_branch: "main",
    });
    const token: string = c.json.result.token;
    const remote: string = c.json.result.remote;
    await api("repo create dup", "POST", `${BASE}/repos`, { name: "base" });
    await api("repo create bad name", "POST", `${BASE}/repos`, { name: "-bad" });
    await api("repo create no name", "POST", `${BASE}/repos`, {});
    await api("repo create read_only", "POST", `${BASE}/repos`, { name: "frozen", read_only: true });
    await api("repo create trunk", "POST", `${BASE}/repos`, { name: "trunky", default_branch: "trunk" });
    await api("repo get", "GET", `${BASE}/repos/base`);
    await api("repo get missing", "GET", `${BASE}/repos/missing`);

    // git push
    const w = join(work, "w");
    mkdirSync(w);
    await git("init", ["init", "-q", "-b", "main", w]);
    writeFileSync(join(w, "README.md"), "# probe\n");
    mkdirSync(join(w, "src"));
    writeFileSync(join(w, "src/a.txt"), "a\n");
    writeFileSync(join(w, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    await git("add", ["-C", w, "add", "-A"]);
    await git("commit first", ["-C", w, "commit", "-q", "-m", "first"]);
    writeFileSync(join(w, "src/b.txt"), "b\n");
    await git("add", ["-C", w, "add", "-A"]);
    await git("commit second", ["-C", w, "commit", "-q", "--cleanup=verbatim", "-m", "second\n\nbody\n\n"]);
    await git("branch side", ["-C", w, "branch", "side"]);
    await git("branch feature/x", ["-C", w, "branch", "feature/x"]);
    await git("tag", ["-C", w, "tag", "-a", "v1", "-m", "release"]);
    await git("push without auth", ["-C", w, "push", remote, "main"]);
    await git("push", ["-C", w, ...auth(token), "push", "-q", remote, "main", "side", "feature/x", "--tags"]);

    // isomorphic-git, as in the Artifacts example: push a new repo, then clone it back.
    const iso = await api("repo create iso", "POST", `${BASE}/repos`, { name: "iso" });
    const isoAuth = () => ({ username: "x", password: String(iso.json.result.token).split("?expires=")[0] });
    const isoDir = join(work, "iso");
    async function isoStep(label: string, fn: () => Promise<unknown>) {
      try {
        const result = await fn();
        out.push({ kind: "git", label, code: 0, remote: [], stdout: JSON.stringify(result ?? null) });
      } catch (e) {
        const err = e as { code?: string; data?: { statusCode?: number } };
        out.push({
          kind: "git",
          label,
          code: 1,
          remote: [`${err.code ?? "Error"} ${err.data?.statusCode ?? ""}`.trim()],
          stdout: "",
        });
      }
    }
    await isogit.init({ fs, dir: isoDir, defaultBranch: "main" });
    fs.writeFileSync(join(isoDir, "README.md"), "# from isomorphic-git\n");
    await isogit.add({ fs, dir: isoDir, filepath: "README.md" });
    await isogit.commit({
      fs,
      dir: isoDir,
      message: "iso",
      author: { name: "probe", email: "probe@example.com", timestamp: 1_760_000_000, timezoneOffset: 0 },
    });
    await isoStep("isomorphic-git push", async () => {
      const r = await isogit.push({
        fs,
        http: isohttp,
        dir: isoDir,
        url: iso.json.result.remote,
        ref: "main",
        onAuth: isoAuth,
      });
      return { ok: r.ok, refs: r.refs };
    });
    await isoStep("isomorphic-git clone", async () => {
      const cloneDir = join(work, "iso-clone");
      await isogit.clone({
        fs,
        http: isohttp,
        dir: cloneDir,
        url: iso.json.result.remote,
        ref: "main",
        singleBranch: true,
        onAuth: isoAuth,
      });
      return { readme: fs.readFileSync(join(cloneDir, "README.md"), "utf8") };
    });
    await isoStep("isomorphic-git push without credentials", async () => {
      await isogit.push({
        fs,
        http: isohttp,
        dir: isoDir,
        url: iso.json.result.remote,
        ref: "main",
        onAuth: () => ({ cancel: true }),
      });
    });

    // Capability advertisements, one pkt-line per entry, and the pushes they rule out.
    async function advertisement(label: string, service: string, proto?: string) {
      const url = `${remote}/info/refs?service=${service}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, ...(proto ? { "git-protocol": proto } : {}) },
      });
      const body = Buffer.from(await res.arrayBuffer());
      let pkts: unknown;
      try {
        pkts = parsePkts(body).map((p) => (p instanceof Buffer ? p.toString("latin1") : p));
      } catch {
        pkts = body.toString("latin1");
      }
      out.push({
        kind: "http",
        label,
        method: "GET",
        path: url,
        request: null,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: pkts,
      });
    }
    await advertisement("advertisement upload-pack v0", "git-upload-pack");
    await advertisement("advertisement upload-pack v2", "git-upload-pack", "version=2");
    await advertisement("advertisement receive-pack", "git-receive-pack");
    // Something new to push: git only checks these capabilities when it has refs to update.
    await git("branch unpushed", ["-C", w, "branch", "unpushed"]);
    await git("push --atomic", [
      "-C",
      w,
      ...auth(token),
      "push",
      "--atomic",
      remote,
      "unpushed",
      "main:refs/heads/main2",
    ]);
    await git("push -o", ["-C", w, ...auth(token), "push", "-o", "ci.skip", remote, "unpushed"]);
    const secret = token.split("?expires=")[0]!;
    const basic = new URL(remote);
    basic.username = "x";
    basic.password = secret;
    await git("ls-remote basic", ["ls-remote", basic.toString()]);
    basic.username = "";
    await git("ls-remote basic empty user", ["ls-remote", basic.toString()]);
    await git("ls-remote bearer secret", [...auth(secret), "ls-remote", remote]);
    await api("repo get after push", "GET", `${BASE}/repos/base`);

    // content
    const log = await api("log", "GET", `${BASE}/repos/base/log?ref=main&limit=10`);
    await api("log default", "GET", `${BASE}/repos/base/log`);
    await api("log offset", "GET", `${BASE}/repos/base/log?limit=1&offset=1`);
    await api("log unknown ref", "GET", `${BASE}/repos/base/log?ref=nope`);
    await api("log limit=0", "GET", `${BASE}/repos/base/log?limit=0`);
    await api("log limit=5000", "GET", `${BASE}/repos/base/log?limit=5000`);
    const head: string = log.json.result[0].hash;
    const commit = await api("commit", "GET", `${BASE}/repos/base/commit/${head}`);
    await api("commit missing", "GET", `${BASE}/repos/base/commit/${"0".repeat(40)}`);
    await api("commit bad hash", "GET", `${BASE}/repos/base/commit/XYZ`);
    const tree = await api("tree", "GET", `${BASE}/repos/base/tree/${commit.json.result.treeHash}`);
    await api("tree of a commit", "GET", `${BASE}/repos/base/tree/${head}`);
    const readme = (tree.json.result as { name: string; hash: string }[]).find((e) => e.name === "README.md")!;
    await api("blob", "GET", `${BASE}/repos/base/blob/${readme.hash}`);
    await api("blob of a commit", "GET", `${BASE}/repos/base/blob/${head}`);
    await api("file", "GET", `${BASE}/repos/base/file?ref=main&path=README.md`);
    await api("file binary", "GET", `${BASE}/repos/base/file?ref=main&path=bin.dat`);
    await api("file missing", "GET", `${BASE}/repos/base/file?ref=main&path=nope`);
    await api("file directory", "GET", `${BASE}/repos/base/file?ref=main&path=src`);
    await api("file no path", "GET", `${BASE}/repos/base/file?ref=main`);
    await api("raw", "GET", `${BASE}/repos/base/raw/main/README.md`);
    await api("raw binary", "GET", `${BASE}/repos/base/raw/main/bin.dat`);
    await api("raw slash ref", "GET", `${BASE}/repos/base/raw/feature/x/src/a.txt`);
    await api("raw by tag", "GET", `${BASE}/repos/base/raw/v1/README.md`);

    // tokens
    const rt = await api("token create read", "POST", `${BASE}/tokens`, { repo: "base", scope: "read", ttl: 600 });
    await api("token create default", "POST", `${BASE}/tokens`, { repo: "base" });
    await api("token ttl 10", "POST", `${BASE}/tokens`, { repo: "base", ttl: 10 });
    await api("token ttl too big", "POST", `${BASE}/tokens`, { repo: "base", ttl: 31536001 });
    await api("token missing repo", "POST", `${BASE}/tokens`, { repo: "missing" });
    await api("tokens list", "GET", `${BASE}/repos/base/tokens`);
    await api("tokens list all per_page=1", "GET", `${BASE}/repos/base/tokens?state=all&per_page=1`);
    const read: string = rt.json.result.plaintext;
    const clone = join(work, "clone");
    await git("clone with read token", [...auth(read), "clone", "-q", remote, clone]);
    writeFileSync(join(clone, "r.txt"), "r");
    await git("add", ["-C", clone, "add", "-A"]);
    await git("commit", ["-C", clone, "commit", "-qm", "reader"]);
    await git("push with read token", ["-C", clone, ...auth(read), "push", remote, "main"]);
    await git("partial clone v2", [
      "-c",
      "protocol.version=2",
      ...auth(read),
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      remote,
      join(work, "pc2"),
    ]);
    await git("partial clone v2 promisor", ["-C", join(work, "pc2"), "config", "--get", "remote.origin.promisor"]);
    // On-demand blob fetch, what ArtifactFS relies on: reading one missing blob fetches only that one.
    const pc2 = join(work, "pc2");
    await git("lazy fetch auth", ["-C", pc2, "config", "http.extraHeader", `Authorization: Bearer ${read}`]);
    await git("lazy fetch missing before", ["-C", pc2, "rev-list", "--objects", "--all", "--missing=print"]);
    const readmeBlob = (await git("lazy fetch blob id", ["-C", pc2, "rev-parse", "HEAD:README.md"])).stdout.trim();
    await git("lazy fetch read blob", ["-C", pc2, "-c", "protocol.version=2", "cat-file", "-p", readmeBlob]);
    await git("lazy fetch missing after", ["-C", pc2, "rev-list", "--objects", "--all", "--missing=print"]);
    await git("partial clone v0", [
      "-c",
      "protocol.version=0",
      ...auth(read),
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      remote,
      join(work, "pc0"),
    ]);
    await git("shallow clone v2", [
      "-c",
      "protocol.version=2",
      ...auth(read),
      "clone",
      "-q",
      "--depth",
      "1",
      remote,
      join(work, "sh2"),
    ]);
    await api("token revoke", "DELETE", `${BASE}/tokens/${rt.json.result.id}`);
    await api("token revoke again", "DELETE", `${BASE}/tokens/${rt.json.result.id}`);
    await api("token revoke unknown", "DELETE", `${BASE}/tokens/zzzzzzzzzzzzzzzz`);
    await git("ls-remote with revoked token", [...auth(read), "ls-remote", remote]);

    // read-only push
    const frozen = (await api("repo get frozen", "GET", `${BASE}/repos/frozen`)).json.result;
    const ft = (await api("token for frozen", "POST", `${BASE}/tokens`, { repo: "frozen" })).json.result.plaintext;
    await git("push to read_only", ["-C", w, ...auth(ft), "push", "-q", frozen.remote, "main"]);

    // fork
    await api("fork", "POST", `${BASE}/repos/base/fork`, { name: "copy" });
    await api("fork default_branch_only", "POST", `${BASE}/repos/base/fork`, {
      name: "copy-only",
      default_branch_only: true,
    });
    await api("fork dup", "POST", `${BASE}/repos/base/fork`, { name: "copy" });
    await api("fork bad name", "POST", `${BASE}/repos/base/fork`, { name: "-x" });
    await api("fork missing source", "POST", `${BASE}/repos/missing/fork`, { name: "z" });
    const copy = (await api("get fork", "GET", `${BASE}/repos/copy-only`)).json.result;
    const ct = (await api("token for fork", "POST", `${BASE}/tokens`, { repo: "copy-only", scope: "read" })).json.result
      .plaintext;
    await git("ls-remote fork", [...auth(ct), "ls-remote", copy.remote]);

    // list
    await api("list", "GET", `${BASE}/repos`);
    const l1 = await api("list limit=2", "GET", `${BASE}/repos?limit=2`);
    await api("list page 2", "GET", `${BASE}/repos?limit=2&cursor=${encodeURIComponent(l1.json.result_info.cursor)}`);
    await api("list sort=name asc", "GET", `${BASE}/repos?sort=name&direction=asc`);
    await api("list search", "GET", `${BASE}/repos?search=cop`);
    await api("list limit=500", "GET", `${BASE}/repos?limit=500`);
    await api("list bad sort", "GET", `${BASE}/repos?sort=size`);
    await api("list missing namespace", "GET", `${t.account}/namespaces/${t.namespace}-missing/repos`);

    // import
    if (!opts.skipNetworkImports) {
      await api("import https", "POST", `${BASE}/repos/hello/import`, {
        url: "https://github.com/octocat/Hello-World",
        depth: 1,
      });
      const imported = (await api("get imported", "GET", `${BASE}/repos/hello`)).json.result;
      const it = (await api("token for imported", "POST", `${BASE}/tokens`, { repo: "hello", scope: "read" })).json
        .result.plaintext;
      await git("ls-remote imported", [...auth(it), "ls-remote", imported.remote]);
      await api("import not a repo", "POST", `${BASE}/repos/h3/import`, { url: "https://example.com/" });
      await api("import missing github repo", "POST", `${BASE}/repos/h4/import`, {
        url: "https://github.com/octocat/definitely-not-a-repo-zz9",
      });
    }
    await api("import http", "POST", `${BASE}/repos/h2/import`, { url: "http://github.com/octocat/Hello-World" });

    // delete
    await api("unknown route", "GET", `${BASE}/widgets`);
    await api("delete repo", "DELETE", `${BASE}/repos/copy`);
    await api("delete repo again", "DELETE", `${BASE}/repos/copy`);
    await api("delete repo never existed", "DELETE", `${BASE}/repos/never-was`);
    await api("get deleted", "GET", `${BASE}/repos/copy`);
  } finally {
    // A transient network error must not leave repos behind: retry each call, keep going past
    // failures, and report what could not be removed.
    const headers = { authorization: `Bearer ${t.token}` };
    const failed: string[] = [];
    const retry = async (what: string, fn: () => Promise<Response>, ok: (r: Response) => boolean) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fn();
          if (ok(r)) return r;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
      failed.push(what);
      return null;
    };
    const list = await retry(
      "list repos",
      () => fetch(`${BASE}/repos?limit=200`, { headers }),
      (r) => r.ok,
    );
    const names = ((await list?.json().catch(() => ({}))) as { result?: { name: string }[] })?.result ?? [];
    for (const { name } of names) {
      await retry(
        `repo ${name}`,
        () => fetch(`${BASE}/repos/${name}`, { method: "DELETE", headers }),
        (r) => r.status < 500,
      );
    }
    try {
      await api("ns delete", "DELETE", BASE);
    } catch {
      await retry(
        "namespace",
        () => fetch(BASE, { method: "DELETE", headers }),
        (r) => r.status < 500,
      );
    }
    rmSync(work, { recursive: true, force: true });
    if (failed.length) process.stderr.write(`cleanup left behind in ${t.namespace}: ${failed.join(", ")}\n`);
  }
  return out;
}
