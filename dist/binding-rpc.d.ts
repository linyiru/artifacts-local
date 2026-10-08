import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
export interface RpcRequest {
    method: string;
    repo?: string;
    args?: unknown[];
}
export type RpcResponse = {
    ok: true;
    result: unknown;
} | {
    ok: true;
    blob: {
        base64: string;
        type: string;
    } | null;
} | {
    ok: false;
    error: {
        code: string;
        numericCode: number;
        message: string;
    };
};
export declare function dispatch(store: Store, ns: string, req: RpcRequest): Promise<RpcResponse>;
export declare function handleBinding(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
