import type { IncomingMessage, ServerResponse } from "node:http";
import { ArtifactsError } from "./errors.ts";
import {
  type TreeEntry,
  log,
  readBlob,
  readCommit,
  readFileAt,
  readTree,
  resolveCommit,
  sniffContentType,
} from "./git.ts";
import type { NamespaceMeta, RepoMeta, RepoSort, Store } from "./store.ts";
import type { TokenInfo, TokenState } from "./tokens.ts";

export const REST_PREFIX = /^\/client\/v4\/accounts\/([^/]+)\/artifacts(\/.*)?$/;

interface ApiError {
  code: number;
  message: string;
}

interface Reply {
  status: number;
  /** No body at all (204). */
  empty?: boolean;
  result?: unknown;
  resultInfo?: Record<string, unknown>;
  bytes?: { data: Buffer; type: string };
}

function send(res: ServerResponse, reply: Reply): void {
  if (reply.empty) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  if (reply.bytes) {
    res.writeHead(reply.status, { "content-type": reply.bytes.type, "content-length": reply.bytes.data.length });
    res.end(reply.bytes.data);
    return;
  }
  const body: Record<string, unknown> = { result: reply.result ?? null, success: true, errors: [], messages: [] };
  if (reply.resultInfo) body.result_info = reply.resultInfo;
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, errors: (ApiError & Record<string, unknown>)[]): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: null, success: false, errors, messages: [] }));
}

// ── wire shapes (snake_case for control-plane objects, as in the REST docs) ──

export function repoInfo(store: Store, m: RepoMeta): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    default_branch: m.defaultBranch,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    last_push_at: m.lastPushAt,
    source: m.source,
    read_only: m.readOnly,
    remote: store.remoteUrl(m.namespace, m.name),
  };
}

/**
 * Live pagination info (2026-10-08): cursor-style while more pages follow, offset-style once
 * everything fits, e.g. `{page: 1, per_page: 50, total_pages: 0, count: 0, total_count: 0}`.
 */
function listInfo(nextCursor: string | undefined, perPage: number, count: number, total: number): Record<string, unknown> {
  if (nextCursor) return { cursor: nextCursor, per_page: perPage, count };
  return { page: 1, per_page: perPage, total_pages: Math.ceil(total / perPage), count, total_count: total };
}

function created(store: Store, m: RepoMeta, token: string): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    default_branch: m.defaultBranch,
    remote: store.remoteUrl(m.namespace, m.name),
    token,
  };
}

// Live shape (2026-10-08); a namespace without a jurisdiction reports "unrestricted".
async function namespaceInfo(store: Store, n: NamespaceMeta): Promise<Record<string, unknown>> {
  return {
    namespace: n.name,
    jurisdiction: n.jurisdiction ?? "unrestricted",
    repo_count: await store.countRepos(n.name),
    created_at: n.createdAt,
    updated_at: n.updatedAt ?? n.createdAt,
  };
}

function tokenInfo(t: TokenInfo): Record<string, unknown> {
  return { id: t.id, scope: t.scope, state: t.state, created_at: t.createdAt, expires_at: t.expiresAt };
}

function treeInfo(e: TreeEntry): Record<string, unknown> {
  return { name: e.name, mode: e.mode, hash: e.hash, type: e.type };
}

// ── request parsing ──

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactsError("INVALID_INPUT", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactsError("INVALID_INPUT", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function intParam(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  if (!/^-?\d+$/.test(v)) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected number, received NaN", `/${name}`);
  return Number(v);
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected string, received ${typeof v}`, `/${key}`);
  return v;
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected boolean, received ${typeof v}`, `/${key}`);
  return v;
}

function optNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected number, received ${typeof v}`, `/${key}`);
  return v;
}

function notFound(message: string): never {
  throw new ArtifactsError("NOT_FOUND", message);
}

const TOKEN_STATES = new Set(["active", "expired", "revoked", "all"]);

/** `raw/:ref/:path` where the ref may itself contain slashes: take the longest prefix that resolves. */
async function splitRefPath(gitDir: string, rest: string[]): Promise<{ ref: string; path: string } | null> {
  for (let i = rest.length - 1; i >= 1; i--) {
    const ref = rest.slice(0, i).join("/");
    if (await resolveCommit(gitDir, ref)) return { ref, path: rest.slice(i).join("/") };
  }
  return null;
}

// ── router ──

async function route(store: Store, req: IncomingMessage, sub: string, q: URLSearchParams): Promise<Reply> {
  const method = req.method ?? "GET";
  const parts = sub.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "namespaces") return noRoute();

  // /namespaces
  if (parts.length === 1) {
    if (method === "POST") {
      const body = await jsonBody(req);
      const ns = await store.createNamespace(body.namespace, body.jurisdiction);
      return { status: 201, result: await namespaceInfo(store, ns) };
    }
    if (method === "GET") {
      const limit = intParam(q, "limit") ?? 50;
      const page = await store.listNamespaces({ limit, cursor: q.get("cursor") ?? undefined });
      return {
        status: 200,
        result: await Promise.all(page.items.map((n) => namespaceInfo(store, n))),
        resultInfo: listInfo(page.nextCursor, limit, page.items.length, page.total),
      };
    }
    return noRoute();
  }

  const ns = parts[1]!;

  // /namespaces/:ns
  if (parts.length === 2) {
    if (method === "GET") return { status: 200, result: await namespaceInfo(store, await store.getNamespace(ns)) };
    if (method === "DELETE") {
      await store.deleteNamespace(ns);
      return { status: 204, empty: true };
    }
    return noRoute();
  }

  // /namespaces/:ns/tokens[/:id]
  if (parts[2] === "tokens") {
    if (parts.length === 3 && method === "POST") {
      const body = await jsonBody(req);
      const repo = body.repo;
      if (typeof repo !== "string" || !repo) throw new ArtifactsError("INVALID_INPUT", "repo required", "/repo");
      const t = await store.createToken(ns, repo, body.scope, body.ttl);
      return {
        status: 201,
        result: { id: t.info.id, plaintext: t.plaintext, scope: t.info.scope, expires_at: t.info.expiresAt },
      };
    }
    if (parts.length === 4 && method === "DELETE") {
      const id = parts[3]!;
      if (!(await store.revokeTokenById(ns, id))) notFound("Token not found");
      return { status: 200, result: { id } };
    }
    return noRoute();
  }

  if (parts[2] !== "repos") return noRoute();

  // /namespaces/:ns/repos
  if (parts.length === 3) {
    if (method === "POST") {
      const body = await jsonBody(req);
      const r = await store.createRepo(ns, body.name, {
        description: optString(body, "description"),
        defaultBranch: optString(body, "default_branch"),
        readOnly: optBool(body, "read_only"),
      });
      return { status: 201, result: created(store, r.meta, r.token) };
    }
    if (method === "GET") {
      const limit = intParam(q, "limit") ?? 50;
      const page = await store.listRepos(ns, {
        limit,
        cursor: q.get("cursor") ?? undefined,
        search: q.get("search") ?? undefined,
        sort: (q.get("sort") ?? undefined) as RepoSort | undefined,
        direction: (q.get("direction") ?? undefined) as "asc" | "desc" | undefined,
      });
      return {
        status: 200,
        // REST list entries carry `status`, unlike a single-repo GET.
        result: page.repos.map((m) => ({ ...repoInfo(store, m), status: m.status })),
        resultInfo: listInfo(page.nextCursor, limit, page.repos.length, page.total),
      };
    }
    return noRoute();
  }

  const name = parts[3]!;
  const action = parts[4];

  // /namespaces/:ns/repos/:name
  if (parts.length === 4) {
    if (method === "GET") return { status: 200, result: repoInfo(store, await store.getReadyRepo(ns, name)) };
    if (method === "DELETE") {
      const meta = (await store.deleteRepo(ns, name)) ?? notFound(`Repository ${name} not found`);
      return { status: 202, result: { id: meta.id } };
    }
    return noRoute();
  }

  if (action === "import" && parts.length === 5 && method === "POST") {
    const body = await jsonBody(req);
    const r = await store.importRepo(ns, name, {
      url: body.url,
      branch: optString(body, "branch"),
      depth: optNumber(body, "depth"),
      readOnly: optBool(body, "read_only"),
    });
    return { status: 201, result: created(store, r.meta, r.token) };
  }

  if (action === "fork" && parts.length === 5 && method === "POST") {
    const body = await jsonBody(req);
    const r = await store.forkRepo(ns, name, body.name, {
      description: optString(body, "description"),
      readOnly: optBool(body, "read_only"),
      defaultBranchOnly: optBool(body, "default_branch_only"),
    });
    return { status: 201, result: { ...created(store, r.meta, r.token), objects: r.objects } };
  }

  if (method !== "GET") return noRoute();
  await store.getReadyRepo(ns, name);
  const gitDir = store.gitDir(ns, name);

  switch (action) {
    case "log": {
      if (parts.length !== 5) return noRoute();
      const commits = await log(gitDir, {
        ref: q.get("ref") || undefined,
        limit: intParam(q, "limit"),
        offset: intParam(q, "offset"),
      });
      // The live service returns the binding's camelCase commit shape here, not snake_case.
      return { status: 200, result: commits };
    }
    case "commit": {
      if (parts.length !== 6) return noRoute();
      const c = (await readCommit(gitDir, parts[5]!)) ?? notFound("Commit not found");
      return { status: 200, result: c };
    }
    case "tree": {
      if (parts.length !== 6) return noRoute();
      const t = (await readTree(gitDir, parts[5]!)) ?? notFound("Tree not found");
      return { status: 200, result: t.map(treeInfo) };
    }
    case "blob": {
      if (parts.length !== 6) return noRoute();
      const b = (await readBlob(gitDir, parts[5]!)) ?? notFound("Blob not found");
      return { status: 200, bytes: { data: b, type: "application/octet-stream" } };
    }
    case "file": {
      if (parts.length !== 5) return noRoute();
      const ref = q.get("ref") ?? "";
      const path = q.get("path") ?? "";
      const f = (await readFileAt(gitDir, ref, path)) ?? notFound("File not found");
      return { status: 200, bytes: { data: f, type: "application/octet-stream" } };
    }
    case "raw": {
      const split = (await splitRefPath(gitDir, parts.slice(5))) ?? notFound("File not found");
      const f = (await readFileAt(gitDir, split.ref, split.path)) ?? notFound("File not found");
      return { status: 200, bytes: { data: f, type: sniffContentType(f) } };
    }
    case "tokens": {
      if (parts.length !== 5) return noRoute();
      const state = q.get("state") ?? "active";
      if (!TOKEN_STATES.has(state)) throw new ArtifactsError("INVALID_INPUT", `Invalid state: ${state}`);
      const perPage = intParam(q, "per_page") ?? 30;
      const page = intParam(q, "page") ?? 1;
      if (perPage < 1 || perPage > 100) throw new ArtifactsError("INVALID_INPUT", "per_page must be between 1 and 100");
      if (page < 1) throw new ArtifactsError("INVALID_INPUT", "page must be at least 1");
      const all = await store.listTokens(ns, name, state as TokenState | "all");
      const items = all.slice((page - 1) * perPage, page * perPage);
      return {
        status: 200,
        result: items.map(tokenInfo),
        resultInfo: {
          page,
          per_page: perPage,
          total_pages: Math.max(1, Math.ceil(all.length / perPage)),
          count: items.length,
          total_count: all.length,
        },
      };
    }
  }
  return noRoute();
}

class NoRoute extends Error {}
function noRoute(): never {
  throw new NoRoute();
}

export interface RestOptions {
  /** If set, REST calls must present exactly this bearer token. Otherwise any bearer is accepted. */
  apiToken?: string;
  /** If set, the account ID in the path must match. */
  accountId?: string;
}

/** Handle a REST request. Returns false when the path is not an Artifacts REST route. */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: RestOptions = {},
): Promise<boolean> {
  const m = REST_PREFIX.exec(url.pathname);
  if (!m) return false;
  const auth = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
  if (!bearer || (opts.apiToken !== undefined && bearer !== opts.apiToken)) {
    sendError(res, 401, [{ code: 10000, message: "Authentication error" }]);
    return true;
  }
  if (opts.accountId !== undefined && m[1] !== opts.accountId) {
    sendError(res, 403, [{ code: 10000, message: "Authentication error" }]);
    return true;
  }
  try {
    send(res, await route(store, req, m[2] ?? "", url.searchParams));
  } catch (e) {
    if (e instanceof NoRoute) {
      sendError(res, 404, [{ code: 7000, message: "No route for that URI" }]);
    } else if (e instanceof ArtifactsError) {
      sendError(res, e.status, [e.toApiError()]);
    } else {
      sendError(res, 500, [{ code: 10400, message: e instanceof Error ? e.message : "Internal error" }]);
    }
  }
  return true;
}
