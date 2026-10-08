import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { ArtifactsError } from "./errors.ts";
import { ISOLATED_GIT_ENV, git, readObjects, parseCommit } from "./git.ts";
import { isValidNamespaceName, isValidRepoName } from "./names.ts";
import type { Store } from "./store.ts";
import type { Scope } from "./tokens.ts";

const ZERO = "0".repeat(40);
const MAX_PUSH_COMMITS = 20;

const ROUTE = /^\/git\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/;

export interface GitRoute {
  ns: string;
  repo: string;
  service: "git-upload-pack" | "git-receive-pack";
  path: string;
}

export function parseGitRoute(method: string, pathname: string, query: URLSearchParams): GitRoute | null {
  const m = ROUTE.exec(pathname);
  if (!m) return null;
  const [, ns, repo, tail] = m as unknown as [string, string, string, string];
  if (!isValidNamespaceName(ns) || !isValidRepoName(repo)) return null;
  let service: string | null;
  if (tail === "/info/refs") {
    if (method !== "GET") return null;
    service = query.get("service");
  } else {
    if (method !== "POST") return null;
    service = tail.slice(1);
  }
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
  return { ns, repo, service, path: tail };
}

/** Bearer `<full token>`, or Basic with any non-empty user and the token secret as password. */
export function presentedToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2) as [string, string | undefined];
  if (!value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(value, "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon < 1) return null;
    return decoded.slice(colon + 1) || null;
  }
  return null;
}

function plain(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(`${message}\n`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Wants/haves/done from an upload-pack request, used to tell clones from fetches. */
export function classifyUploadPack(body: Buffer, encoding: string | undefined): "clone" | "fetch" | "none" {
  let text: string;
  try {
    text = (encoding === "gzip" ? gunzipSync(body) : body).toString("latin1");
  } catch {
    return "none";
  }
  if (!/want [0-9a-f]{40}/.test(text)) return "none";
  if (!/have [0-9a-f]{40}/.test(text)) return "clone";
  // Only the final negotiation round carries the `done` pkt-line; earlier rounds are not fetches yet.
  return text.includes("0009done\n") ? "fetch" : "none";
}

async function refSnapshot(gitDir: string): Promise<Map<string, string>> {
  const r = await git(["--git-dir", gitDir, "for-each-ref", "--format=%(objectname) %(refname)"]);
  const map = new Map<string, string>();
  for (const line of r.stdout.toString().split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    map.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return map;
}

/** Payloads for `cf.artifacts.repo.pushed`, one per updated ref. */
export async function pushPayloads(
  gitDir: string,
  before: Map<string, string>,
  after: Map<string, string>,
): Promise<Record<string, unknown>[]> {
  const refs = new Set([...before.keys(), ...after.keys()]);
  const payloads: Record<string, unknown>[] = [];
  for (const ref of [...refs].sort()) {
    const b = before.get(ref) ?? ZERO;
    const a = after.get(ref) ?? ZERO;
    if (a === b) continue;
    let hashes: string[] = [];
    if (a !== ZERO) {
      const exclude = [...new Set(before.values())].map((h) => `^${h}`);
      const r = await git(["--git-dir", gitDir, "rev-list", a, ...exclude]);
      hashes = r.stdout.toString().split("\n").filter(Boolean);
    }
    const shown = hashes.slice(0, MAX_PUSH_COMMITS);
    const objects = await readObjects(gitDir, shown);
    payloads.push({
      ref,
      before: b,
      after: a,
      commits: objects.flatMap((o, i) => {
        if (!o || o.type !== "commit") return [];
        const c = parseCommit(shown[i]!, o.data);
        return [{
          id: c.hash,
          message: c.message,
          messageTruncated: false,
          timestamp: new Date(c.committedAt * 1000).toISOString(),
          author: c.author,
          committer: c.committer,
          parents: c.parents,
        }];
      }),
      totalCommitsCount: hashes.length,
      commitsTruncated: hashes.length > shown.length,
    });
  }
  return payloads;
}

/** Serialise pushes per repo so ref snapshots attribute updates to the right push. */
const pushLocks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pushLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  pushLocks.set(key, next.catch(() => {}));
  return next;
}

/** Run `git http-backend` as a CGI and stream its response. */
function runBackend(
  store: Store,
  route: GitRoute,
  req: IncomingMessage,
  res: ServerResponse,
  query: string,
  body: Buffer | null,
): Promise<number> {
  const gitDir = store.gitDir(route.ns, route.repo);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...ISOLATED_GIT_ENV,
    GIT_PROJECT_ROOT: dirname(gitDir),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${route.repo}.git${route.path}`,
    REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: query,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: "artifacts",
    REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
  // Artifacts supports protocol v2 for upload-pack only; receive-pack always speaks v0/v1.
  const proto = req.headers["git-protocol"];
  if (route.service === "git-upload-pack" && typeof proto === "string") env.GIT_PROTOCOL = proto;

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let headerBuf = Buffer.alloc(0);
    let headersSent = false;
    let status = 200;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      let end = headerBuf.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (end === -1) {
        end = headerBuf.indexOf("\n\n");
        sepLen = 2;
      }
      if (end === -1) return;
      const headers: Record<string, string> = {};
      for (const line of headerBuf.subarray(0, end).toString().split(/\r?\n/)) {
        const colon = line.indexOf(":");
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      headersSent = true;
      const rest = headerBuf.subarray(end + sepLen);
      if (rest.length) res.write(rest);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!headersSent) plain(res, 500, "git http-backend failed");
      res.end();
      resolve(code === 0 ? status : 500);
    });
    child.stdin.on("error", () => {});
    if (body) child.stdin.end(body);
    else req.pipe(child.stdin);
  });
}

/** Handle a Git smart HTTP request. Returns false when the path is not a git route. */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const route = parseGitRoute(req.method ?? "GET", url.pathname, url.searchParams);
  if (!route) {
    if (url.pathname.startsWith("/git/")) {
      plain(res, 404, "Not found");
      return true;
    }
    return false;
  }

  let meta;
  try {
    meta = await store.getReadyRepo(route.ns, route.repo);
  } catch (e) {
    const err = e as ArtifactsError;
    plain(res, err.status ?? 500, err.message);
    return true;
  }

  const needed: Scope = route.service === "git-receive-pack" ? "write" : "read";
  const token = presentedToken(req.headers.authorization);
  const auth = token ? await store.authenticate(route.ns, route.repo, token, needed) : "unauthorized";
  if (auth === "unauthorized") {
    plain(res, 401, "Authentication required", { "www-authenticate": 'Basic realm="Artifacts"' });
    return true;
  }
  if (auth === "forbidden") {
    plain(res, 403, "This token does not allow push; a write token is required");
    return true;
  }
  if (needed === "write" && meta.readOnly) {
    plain(res, 403, "Repository is read-only");
    return true;
  }

  const query = url.search.slice(1);
  if (route.service === "git-upload-pack") {
    if (route.path === "/info/refs") {
      await runBackend(store, route, req, res, query, null);
      return true;
    }
    const body = await readBody(req);
    const kind = classifyUploadPack(body, req.headers["content-encoding"] as string | undefined);
    const status = await runBackend(store, route, req, res, query, body);
    if (status === 200 && kind !== "none") {
      store.events.emit(kind === "clone" ? "cf.artifacts.repo.cloned" : "cf.artifacts.repo.fetched", route.ns, route.repo, {});
    }
    return true;
  }

  if (route.path === "/info/refs") {
    await runBackend(store, route, req, res, query, null);
    return true;
  }
  const gitDir = store.gitDir(route.ns, route.repo);
  await withLock(gitDir, async () => {
    const before = await refSnapshot(gitDir);
    await runBackend(store, route, req, res, query, null);
    const after = await refSnapshot(gitDir);
    const payloads = await pushPayloads(gitDir, before, after);
    if (payloads.length) {
      await store.recordPush(route.ns, route.repo);
      for (const p of payloads) store.events.emit("cf.artifacts.repo.pushed", route.ns, route.repo, p);
    }
  });
  return true;
}
