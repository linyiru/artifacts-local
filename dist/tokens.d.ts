export type Scope = "read" | "write";
export type TokenState = "active" | "expired" | "revoked";
export declare const DEFAULT_TTL = 86400;
export declare const MIN_TTL = 60;
export declare const MAX_TTL = 31536000;
/** What is persisted for a token. The plaintext secret is never stored. */
export interface TokenRecord {
    id: string;
    scope: Scope;
    secretHash: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
}
export interface TokenInfo {
    id: string;
    scope: Scope;
    state: TokenState;
    createdAt: string;
    expiresAt: string;
}
export interface IssuedToken {
    record: TokenRecord;
    plaintext: string;
}
/** 16 lowercase base-36 characters, the shape of repo and token IDs in the docs. */
export declare function newId(): string;
export declare function hashSecret(secret: string): string;
export declare function resolveScope(scope: unknown): Scope;
export declare function resolveTtl(ttl: unknown): number;
export declare function issueToken(scope: unknown, ttl: unknown, now: number): IssuedToken;
/**
 * Accepts the full token (`art_v2_x_<hex>?expires=<n>`) or just the secret part. The live service
 * issues `art_v2_x_`; the docs still describe `art_v1_`, which is accepted too.
 * Returns the secret, or null if the string is not token-shaped.
 */
export declare function parseSecret(token: string): string | null;
export declare function tokenState(record: TokenRecord, now: number): TokenState;
export declare function toTokenInfo(record: TokenRecord, now: number): TokenInfo;
export declare function scopeAllows(granted: Scope, needed: Scope): boolean;
