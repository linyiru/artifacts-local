import { createHash, randomBytes } from "node:crypto";
import { ArtifactsError } from "./errors.ts";

export type Scope = "read" | "write";
export type TokenState = "active" | "expired" | "revoked";

export const DEFAULT_TTL = 86_400;
export const MIN_TTL = 60;
export const MAX_TTL = 31_536_000;

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

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 16 lowercase base-36 characters, the shape of repo and token IDs in the docs. */
export function newId(): string {
  const bytes = randomBytes(16);
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % 36];
  return id;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function resolveScope(scope: unknown): Scope {
  if (scope === undefined || scope === null) return "write";
  if (scope === "read" || scope === "write") return scope;
  throw new ArtifactsError("INVALID_INPUT", `Invalid token scope: ${JSON.stringify(scope)}`);
}

export function resolveTtl(ttl: unknown): number {
  if (ttl === undefined || ttl === null) return DEFAULT_TTL;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) {
    throw new ArtifactsError("INVALID_TTL", `Token TTL must be an integer between ${MIN_TTL} and ${MAX_TTL} seconds`);
  }
  return ttl;
}

export function issueToken(scope: unknown, ttl: unknown, now: number): IssuedToken {
  const s = resolveScope(scope);
  const t = resolveTtl(ttl);
  const secret = `art_v1_${randomBytes(20).toString("hex")}`;
  const expiresSec = Math.floor(now / 1000) + t;
  const record: TokenRecord = {
    id: newId(),
    scope: s,
    secretHash: hashSecret(secret),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresSec * 1000).toISOString(),
    revokedAt: null,
  };
  return { record, plaintext: `${secret}?expires=${expiresSec}` };
}

/**
 * Accepts the full token (`art_v1_<hex>?expires=<n>`) or just the secret part.
 * Returns the secret, or null if the string is not token-shaped.
 */
export function parseSecret(token: string): string | null {
  const secret = token.split("?expires=")[0] ?? "";
  return /^art_v1_[0-9a-f]{40}$/.test(secret) ? secret : null;
}

export function tokenState(record: TokenRecord, now: number): TokenState {
  if (record.revokedAt) return "revoked";
  if (Date.parse(record.expiresAt) <= now) return "expired";
  return "active";
}

export function toTokenInfo(record: TokenRecord, now: number): TokenInfo {
  return {
    id: record.id,
    scope: record.scope,
    state: tokenState(record, now),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export function scopeAllows(granted: Scope, needed: Scope): boolean {
  return granted === "write" || needed === "read";
}
