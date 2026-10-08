import type { IncomingMessage, ServerResponse } from "node:http";
import { type Store } from "./store.js";
export interface GitRoute {
    ns: string;
    repo: string;
    service: "git-upload-pack" | "git-receive-pack";
    path: string;
}
export declare function parseGitRoute(method: string, pathname: string, query: URLSearchParams): GitRoute | null;
/** Bearer `<full token>` or `<secret>`, or Basic with any user (live accepts an empty one) and the secret as password. */
export declare function presentedToken(header: string | undefined): string | null;
/**
 * Wants and haves in an upload-pack request: no haves means a clone. Whether this round actually
 * transferred objects is decided from the response (see `PackDetector`), because a protocol v2
 * client sends no `done` when the server can answer `ready` with the pack straight away.
 */
export declare function classifyUploadPack(body: Buffer, encoding: string | undefined): "clone" | "fetch" | "none";
/** Spots a packfile (`PACK` on sideband channel 1) in a streamed upload-pack response. */
export declare class PackDetector {
    found: boolean;
    private tail;
    push(chunk: Buffer): void;
}
/** Payloads for `cf.artifacts.repo.pushed`, one per updated ref. */
export declare function pushPayloads(gitDir: string, before: Map<string, string>, after: Map<string, string>): Promise<Record<string, unknown>[]>;
/** Handle a Git smart HTTP request. Returns false when the path is not a git route. */
export declare function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
