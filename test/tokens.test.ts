import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL,
  MAX_TTL,
  MIN_TTL,
  hashSecret,
  issueToken,
  newId,
  parseSecret,
  resolveScope,
  resolveTtl,
  scopeAllows,
  toTokenInfo,
  tokenState,
} from "../src/tokens.ts";

const NOW = Date.parse("2026-10-08T00:00:00Z");

describe("tokens", () => {
  it("issues tokens in the documented art_v1_<40 hex>?expires=<unix> format", () => {
    const { plaintext, record } = issueToken("read", 3600, NOW);
    expect(plaintext).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/);
    const expires = Number(plaintext.split("?expires=")[1]);
    expect(expires).toBe(NOW / 1000 + 3600);
    expect(record.expiresAt).toBe(new Date(expires * 1000).toISOString());
    expect(record.createdAt).toBe(new Date(NOW).toISOString());
    expect(record.scope).toBe("read");
    expect(record.secretHash).toBe(hashSecret(parseSecret(plaintext)!));
    expect(record.secretHash).not.toContain("art_v1_");
  });

  it("defaults to write scope and a 24 hour TTL", () => {
    const { record } = issueToken(undefined, undefined, NOW);
    expect(record.scope).toBe("write");
    expect(Date.parse(record.expiresAt) - NOW).toBe(DEFAULT_TTL * 1000);
    expect(resolveScope(null)).toBe("write");
    expect(resolveTtl(null)).toBe(DEFAULT_TTL);
  });

  it.each([MIN_TTL - 1, MAX_TTL + 1, 1.5, "60", 0, -1])("rejects ttl %s with INVALID_TTL", (ttl) => {
    expect(() => resolveTtl(ttl)).toThrowError(expect.objectContaining({ code: "INVALID_TTL" }));
  });

  it("accepts the TTL bounds", () => {
    expect(resolveTtl(MIN_TTL)).toBe(MIN_TTL);
    expect(resolveTtl(MAX_TTL)).toBe(MAX_TTL);
  });

  it("rejects unknown scopes with INVALID_INPUT", () => {
    expect(() => resolveScope("admin")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("parses the secret from a full token or a bare secret", () => {
    const secret = `art_v1_${"a".repeat(40)}`;
    expect(parseSecret(`${secret}?expires=123`)).toBe(secret);
    expect(parseSecret(secret)).toBe(secret);
    expect(parseSecret("art_v1_short")).toBeNull();
    expect(parseSecret("ghp_xxx")).toBeNull();
    expect(parseSecret("")).toBeNull();
  });

  it("derives state from revocation and expiry", () => {
    const { record } = issueToken("write", 60, NOW);
    expect(tokenState(record, NOW)).toBe("active");
    expect(tokenState(record, NOW + 60_000)).toBe("expired");
    expect(tokenState({ ...record, revokedAt: new Date(NOW).toISOString() }, NOW)).toBe("revoked");
    expect(toTokenInfo(record, NOW)).toEqual({
      id: record.id,
      scope: "write",
      state: "active",
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    });
  });

  it("makes 16-character base-36 IDs", () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{16}$/);
  });

  it("lets write cover read but not the reverse", () => {
    expect(scopeAllows("write", "write")).toBe(true);
    expect(scopeAllows("write", "read")).toBe(true);
    expect(scopeAllows("read", "read")).toBe(true);
    expect(scopeAllows("read", "write")).toBe(false);
  });
});
