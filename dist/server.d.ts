import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type RestOptions } from "./rest.js";
import { Store } from "./store.js";
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
    trackPushTimes?: boolean;
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
export declare function startServer(opts: ServerOptions, extra?: Handler[]): Promise<RunningServer>;
