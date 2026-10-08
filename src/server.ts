import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventBus, webhookListener } from "./events.ts";
import { type FaultOptions, Faults, RateLimiter } from "./limits.ts";
import { DIMENSIONS, type Dimension, type Filter, PRICING, estimateCost } from "./metrics.ts";
import { handleGit } from "./git-http.ts";
import { type RestOptions, handleRest, sendError } from "./rest.ts";
import { Store } from "./store.ts";

export interface ServerOptions extends RestOptions {
  dataDir: string;
  port?: number;
  host?: string;
  /** Base URL used in `remote` fields. Defaults to the listening address. */
  publicUrl?: string;
  /** POST every event to this URL (a local stand-in for an event subscription). */
  webhookUrl?: string;
  /** Event subscriptions to create at start, as `subscriptions.create(queue, …)` takes them. */
  subscriptions?: { queue: string; source: unknown; events?: string[] }[];
  asyncDelayMs?: number;
  allowInsecureImport?: boolean;
  maxBlobBytes?: number;
  trackPushTimes?: boolean;
  /** Largest repository a push may grow to; defaults to the documented 1 GB. */
  maxRepoBytes?: number;
  /** Throttle per namespace (REST, binding) and per repo (git), e.g. the documented 2000 per 10 s. */
  rateLimit?: { requests: number; windowMs: number };
  /** Answer a share of requests with a 500, and/or add latency. */
  faults?: FaultOptions;
  now?: () => number;
}

export interface RunningServer {
  url: string;
  store: Store;
  server: Server;
  close(): Promise<void>;
}

/** Extra handlers mounted under the same server, e.g. the binding RPC endpoint. */
export type Handler = (store: Store, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

async function handleLocal(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/__local/")) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/__local/health") {
    json(200, { ok: true });
    return true;
  }
  if (url.pathname === "/__local/events") {
    if (req.method === "DELETE") {
      store.events.history.length = 0;
      json(200, { ok: true });
      return true;
    }
    const type = url.searchParams.get("type");
    json(
      200,
      store.events.history.filter((e) => !type || e.type === type),
    );
    return true;
  }
  if (url.pathname === "/__local/metrics" && req.method === "GET") {
    // The artifactsEventsAdaptiveGroups fields, without GraphQL: ?groupBy=a,b&<filter>=…&limit=n
    const q = url.searchParams;
    const by = (q.get("groupBy") ?? "").split(",").filter(Boolean);
    const unknown = by.filter((d) => !(DIMENSIONS as readonly string[]).includes(d));
    if (unknown.length) {
      json(400, { error: `unknown dimension: ${unknown.join(", ")}; use ${DIMENSIONS.join(", ")}` });
      return true;
    }
    const filter: Filter = {};
    for (const k of [
      "datetime_geq",
      "datetime_leq",
      "repository",
      "repositoryNamespace",
      "repositoryName",
      "eventKind",
      "eventType",
    ] as const) {
      const v = q.get(k);
      if (v) (filter as Record<string, string>)[k] = v;
    }
    json(200, {
      artifactsEventsAdaptiveGroups: store.metrics.groups(filter, by as Dimension[], Number(q.get("limit") ?? 100)),
    });
    return true;
  }
  if (url.pathname === "/__local/usage" && req.method === "GET") {
    // Recorded usage and its monthly cost; ?operations=&storageGb= projects other volumes.
    const q = url.searchParams;
    const byType = Object.fromEntries(
      store.metrics.groups({ eventKind: "action" }, ["eventType"], 1000).map((g) => [g.dimensions.eventType!, g.count]),
    );
    const operations = Object.values(byType).reduce((a, b) => a + b, 0);
    const storageBytes = await store.storageBytes();
    const projected = q.has("operations") || q.has("storageGb");
    json(200, {
      recorded: { operations, byType, storageBytes },
      estimate: estimateCost(
        q.has("operations") ? Number(q.get("operations")) : operations,
        q.has("storageGb") ? Number(q.get("storageGb")) : storageBytes / 1024 ** 3,
      ),
      basis: projected ? "projection" : "recorded",
      pricing: PRICING,
      note: "Counts every successful operation; which ones Cloudflare bills is not documented beyond create, push, pull, and clone.",
    });
    return true;
  }
  const queue = /^\/__local\/queues\/([^/]+)\/(subscriptions|messages)(?:\/([^/]+))?$/.exec(url.pathname);
  if (queue) {
    const [, name, kind, id] = queue as unknown as [string, string, string, string | undefined];
    const subs = store.events.subscriptions;
    if (kind === "messages" && req.method === "GET" && !id) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      json(200, subs.pull(decodeURIComponent(name), after, limit));
      return true;
    }
    if (kind === "subscriptions" && !id && req.method === "GET") {
      json(200, subs.list(decodeURIComponent(name)));
      return true;
    }
    if (kind === "subscriptions" && !id && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        json(201, subs.create(decodeURIComponent(name), JSON.parse(Buffer.concat(chunks).toString() || "{}")));
      } catch (e) {
        json(400, { error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }
    if (kind === "subscriptions" && id && req.method === "DELETE") {
      json(subs.delete(id) ? 200 : 404, { id });
      return true;
    }
  }
  return false;
}

interface Target {
  surface: "rest" | "git" | "binding";
  /** Rate-limit key: per namespace for the control plane, per repo for git. */
  key: string;
  namespace: string;
  repo: string;
}

/** The Artifacts surface a request is for, or null for local admin and unknown paths. */
export function classify(pathname: string): Target | null {
  const rest = /^\/client\/v4\/accounts\/[^/]+\/artifacts\/namespaces(?:\/([^/]+))?(?:\/repos\/([^/]+))?/.exec(
    pathname,
  );
  if (rest) {
    const ns = decodeURIComponent(rest[1] ?? "");
    return { surface: "rest", key: `ns:${ns}`, namespace: ns, repo: decodeURIComponent(rest[2] ?? "") };
  }
  const gitPath = /^\/git\/([^/]+)\/([^/]+)\.git\//.exec(pathname);
  if (gitPath) {
    return { surface: "git", key: `repo:${gitPath[1]}/${gitPath[2]}`, namespace: gitPath[1]!, repo: gitPath[2]! };
  }
  const binding = /^\/__local\/binding\/([^/]+)$/.exec(pathname);
  if (binding) return { surface: "binding", key: `ns:${binding[1]}`, namespace: binding[1]!, repo: "" };
  return null;
}

/** Apply rate limiting and injected faults. True when the request was answered here. */
async function guard(store: Store, t: Target, limiter: RateLimiter | undefined, faults: Faults, res: ServerResponse) {
  const answer = (status: number, rest: { code: number; message: string }, headers: Record<string, string> = {}) => {
    if (t.surface === "git") {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
      res.end(`${rest.message}\n`);
    } else {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ result: null, success: false, errors: [rest], messages: [] }));
    }
  };
  if (limiter && !limiter.take(t.key)) {
    store.metrics.record({
      repositoryNamespace: t.namespace,
      repositoryName: t.repo,
      eventKind: "error",
      eventType: "rateLimited",
      errorMessage: "rate limited",
      durationMs: 0,
    });
    // Cloudflare's API answers throttling with 429 and code 971; what Artifacts sends is not documented.
    answer(
      429,
      { code: 971, message: "Please wait and consider throttling your request speed" },
      {
        "retry-after": String(limiter.retryAfter(t.key)),
      },
    );
    return true;
  }
  await faults.delay();
  if (faults.shouldFail()) {
    store.metrics.record({
      repositoryNamespace: t.namespace,
      repositoryName: t.repo,
      eventKind: "error",
      eventType: "serverError",
      errorMessage: "injected failure",
      durationMs: 0,
    });
    answer(500, { code: 10400, message: "An unexpected internal error occurred." });
    return true;
  }
  return false;
}

export async function startServer(opts: ServerOptions, extra: Handler[] = []): Promise<RunningServer> {
  const now = opts.now ?? Date.now;
  const events = new EventBus(opts.accountId ?? "local", now);
  if (opts.webhookUrl) events.subscribe(webhookListener(opts.webhookUrl));
  for (const s of opts.subscriptions ?? []) events.subscriptions.create(s.queue, s);
  const store = new Store({
    dataDir: opts.dataDir,
    accountId: opts.accountId,
    events,
    now,
    asyncDelayMs: opts.asyncDelayMs,
    allowInsecureImport: opts.allowInsecureImport,
    maxBlobBytes: opts.maxBlobBytes,
    trackPushTimes: opts.trackPushTimes,
    maxRepoBytes: opts.maxRepoBytes,
  });
  const handlers: Handler[] = [
    handleLocal,
    (s, req, res, url) => handleRest(s, req, res, url, opts),
    handleGit,
    ...extra,
  ];

  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit.requests, opts.rateLimit.windowMs, now) : undefined;
  const faults = new Faults(opts.faults);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (limiter || faults.active) {
        const target = classify(url.pathname);
        if (target && (await guard(store, target, limiter, faults, res))) return;
      }
      for (const h of handlers) {
        if (await h(store, req, res, url)) return;
      }
      sendError(res, 404, [{ code: 7000, message: "No route for that URI" }]);
    } catch (e) {
      if (!res.headersSent)
        sendError(res, 500, [{ code: 10400, message: e instanceof Error ? e.message : "Internal error" }]);
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  store.publicUrl = opts.publicUrl ?? url;
  return {
    url,
    store,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
