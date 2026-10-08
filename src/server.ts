import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EventBus, webhookListener } from "./events.ts";
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
  asyncDelayMs?: number;
  allowInsecureImport?: boolean;
  maxBlobBytes?: number;
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
    json(200, store.events.history.filter((e) => !type || e.type === type));
    return true;
  }
  return false;
}

export async function startServer(opts: ServerOptions, extra: Handler[] = []): Promise<RunningServer> {
  const now = opts.now ?? Date.now;
  const events = new EventBus(opts.accountId ?? "local", now);
  if (opts.webhookUrl) events.subscribe(webhookListener(opts.webhookUrl));
  const store = new Store({
    dataDir: opts.dataDir,
    accountId: opts.accountId,
    events,
    now,
    asyncDelayMs: opts.asyncDelayMs,
    allowInsecureImport: opts.allowInsecureImport,
    maxBlobBytes: opts.maxBlobBytes,
  });
  const handlers: Handler[] = [
    handleLocal,
    (s, req, res, url) => handleRest(s, req, res, url, opts),
    handleGit,
    ...extra,
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const h of handlers) {
        if (await h(store, req, res, url)) return;
      }
      sendError(res, 404, [{ code: 7000, message: "No route for that URI" }]);
    } catch (e) {
      if (!res.headersSent) sendError(res, 500, [{ code: 10400, message: e instanceof Error ? e.message : "Internal error" }]);
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
