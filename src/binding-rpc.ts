import type { IncomingMessage, ServerResponse } from "node:http";
import { ArtifactsError } from "./errors.ts";
import { log, readBlob, readCommit, readFileAt, readTree, sniffContentType } from "./git.ts";
import { assertNamespaceName } from "./names.ts";
import type { RepoMeta, Store } from "./store.ts";

// Server side of the binding emulation: one POST per binding call, answered with
// exactly what the Workers binding returns (camelCase, `status` on list entries).

export interface RpcRequest {
  method: string;
  repo?: string;
  args?: unknown[];
}

export type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: true; blob: { base64: string; type: string } | null }
  | { ok: false; error: { code: string; numericCode: number; message: string } };

function info(store: Store, m: RepoMeta) {
  return { ...listEntry(m), remote: store.remoteUrl(m.namespace, m.name) };
}

function listEntry(m: RepoMeta) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    defaultBranch: m.defaultBranch,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastPushAt: m.lastPushAt,
    source: m.source,
    readOnly: m.readOnly,
    status: m.status,
  };
}

function created(store: Store, m: RepoMeta, token: string) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    defaultBranch: m.defaultBranch,
    remote: store.remoteUrl(m.namespace, m.name),
    token,
  };
}

type Opts = Record<string, unknown>;
const asOpts = (v: unknown): Opts => (v && typeof v === "object" ? (v as Opts) : {});

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

async function namespaceCall(store: Store, ns: string, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "create": {
      const o = asOpts(args[1]);
      const r = await store.createRepo(ns, args[0], {
        readOnly: bool(o.readOnly),
        description: str(o.description),
        defaultBranch: str(o.setDefaultBranch),
      });
      return created(store, r.meta, r.token);
    }
    case "get": {
      // The binding's get() resolves to a handle; here it only checks the repo is ready.
      await store.getReadyRepo(ns, args[0] as string);
      return null;
    }
    case "list": {
      const o = asOpts(args[0]);
      const page = await store.listRepos(ns, { limit: num(o.limit), cursor: str(o.cursor) });
      const out: Record<string, unknown> = { repos: page.repos.map(listEntry), total: page.total };
      if (page.nextCursor) out.cursor = page.nextCursor;
      return out;
    }
    case "import": {
      const p = asOpts(args[0]);
      const source = asOpts(p.source);
      const target = asOpts(p.target);
      const topts = asOpts(target.opts);
      const r = await store.importRepo(ns, target.name, {
        url: source.url,
        branch: str(source.branch),
        depth: num(source.depth),
        description: str(topts.description),
        readOnly: bool(topts.readOnly),
      });
      return created(store, r.meta, r.token);
    }
    case "delete":
      return (await store.deleteRepo(ns, args[0])) !== null;
  }
  throw new ArtifactsError("INVALID_INPUT", `Unknown binding method: ${method}`);
}

const ok = (result: unknown): RpcResponse => ({ ok: true, result });
const blob = (data: Buffer | null, type: string): RpcResponse => ({
  ok: true,
  blob: data ? { base64: data.toString("base64"), type } : null,
});

async function repoCall(store: Store, ns: string, repo: string, method: string, args: unknown[]): Promise<RpcResponse> {
  const meta = await store.getReadyRepo(ns, repo);
  const gitDir = store.gitDir(ns, repo);
  switch (method) {
    case "info":
      return ok(info(store, meta));
    case "createToken": {
      const t = await store.createToken(ns, repo, args[0], args[1]);
      return ok({ id: t.info.id, plaintext: t.plaintext, scope: t.info.scope, expiresAt: t.info.expiresAt });
    }
    case "listTokens": {
      const tokens = await store.listTokens(ns, repo, "all");
      return ok({ tokens, total: tokens.length });
    }
    case "revokeToken":
      return ok(await store.revokeToken(ns, repo, args[0]));
    case "fork": {
      const o = asOpts(args[1]);
      const r = await store.forkRepo(ns, repo, args[0], {
        description: str(o.description),
        readOnly: bool(o.readOnly),
        defaultBranchOnly: bool(o.defaultBranchOnly),
      });
      return ok(created(store, r.meta, r.token));
    }
    case "log": {
      const o = asOpts(args[0]);
      return ok(await log(gitDir, { ref: str(o.ref), limit: num(o.limit), offset: num(o.offset) }));
    }
    case "readCommit":
      return ok(await readCommit(gitDir, args[0] as string));
    case "readTree":
      return ok(await readTree(gitDir, args[0] as string));
    case "readBlob":
      return blob(await readBlob(gitDir, args[0] as string), "");
    case "readFile": {
      const o = asOpts(args[0]);
      const ref = str(o.ref) ?? "";
      const path = str(o.path) ?? "";
      const data = await readFileAt(gitDir, ref, path);
      return blob(data, data ? sniffContentType(data) : "");
    }
  }
  throw new ArtifactsError("INVALID_INPUT", `Unknown repository method: ${method}`);
}

/** The live metrics event type of a binding call. */
const BINDING_EVENT_TYPES: Record<string, string> = {
  create: "create",
  import: "create",
  delete: "delete",
  fork: "fork",
  createToken: "token_create",
  revokeToken: "token_revoke",
};

export async function dispatch(store: Store, ns: string, req: RpcRequest): Promise<RpcResponse> {
  const args = Array.isArray(req.args) ? req.args : [];
  const target = req.repo ?? (["create", "get", "delete"].includes(req.method) ? args[0] : undefined);
  const op = {
    type: BINDING_EVENT_TYPES[req.method] ?? "read",
    namespace: ns,
    repo: typeof target === "string" ? target : "",
  };
  const started = performance.now();
  try {
    assertNamespaceName(ns);
    const out =
      req.repo !== undefined
        ? await repoCall(store, ns, req.repo, req.method, args)
        : ({ ok: true, result: await namespaceCall(store, ns, req.method, args) } as RpcResponse);
    store.metrics?.recordOperation(op, 200, performance.now() - started);
    return out;
  } catch (e) {
    const err =
      e instanceof ArtifactsError
        ? e
        : new ArtifactsError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
    store.metrics?.recordOperation(op, err.status, performance.now() - started);
    return { ok: false, error: { code: err.code, numericCode: err.numericCode, message: err.message } };
  }
}

const ROUTE = /^\/__local\/binding\/([^/]+)$/;

export async function handleBinding(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const m = ROUTE.exec(url.pathname);
  if (!m || req.method !== "POST") return false;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body: RpcRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString()) as RpcRequest;
  } catch {
    body = { method: "" };
  }
  const out = await dispatch(store, decodeURIComponent(m[1]!), body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
  return true;
}
