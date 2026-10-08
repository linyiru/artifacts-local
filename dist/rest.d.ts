import type { IncomingMessage, ServerResponse } from "node:http";
import type { RepoMeta, Store } from "./store.js";
export declare const REST_PREFIX: RegExp;
interface ApiError {
    code: number;
    message: string;
}
export declare function sendError(res: ServerResponse, status: number, errors: (ApiError & Record<string, unknown>)[]): void;
export declare function repoInfo(store: Store, m: RepoMeta): Record<string, unknown>;
export interface RestOptions {
    /** If set, REST calls must present exactly this bearer token. Otherwise any bearer is accepted. */
    apiToken?: string;
    /** If set, the account ID in the path must match. */
    accountId?: string;
}
/** Handle a REST request. Returns false when the path is not an Artifacts REST route. */
export declare function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, opts?: RestOptions): Promise<boolean>;
export {};
