import { describe, expect, it } from "vitest";
import { ArtifactsError, codeFromNumeric, isArtifactsError } from "../src/errors.ts";
import {
  assertHash,
  assertNamespaceName,
  assertRepoName,
  isValidNamespaceName,
  isValidRepoName,
} from "../src/names.ts";

describe("ArtifactsError", () => {
  it("carries the documented numeric code and an HTTP status", () => {
    const err = new ArtifactsError("NOT_FOUND", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ArtifactsError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.numericCode).toBe(10200);
    expect(err.status).toBe(404);
    expect(err.message).toBe("nope");
    expect(isArtifactsError(err)).toBe(true);
    expect(isArtifactsError(new Error("x"))).toBe(false);
    expect(Object.keys(err).toSorted()).toEqual(["code", "name", "numericCode"]);
  });

  it("renders the live REST error entry, with source.pointer when known", () => {
    expect(new ArtifactsError("INVALID_TTL", "ttl bad", "/ttl").toApiError()).toEqual({
      code: 10103,
      message: "ttl bad",
      documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10103",
      source: { pointer: "/ttl" },
    });
    const plain = new ArtifactsError("NOT_FOUND", "Repository not found");
    expect(plain.toApiError()).not.toHaveProperty("source");
    expect(plain.pointer).toBeUndefined();
    const pointed = new ArtifactsError("INVALID_INPUT", "x", "/name");
    expect(pointed.pointer).toBe("/name");
    expect(Object.keys(pointed).toSorted()).toEqual(["code", "name", "numericCode"]);
  });

  it("answers REMOTE_AUTH_REQUIRED with 422, as the live service does", () => {
    expect(new ArtifactsError("REMOTE_AUTH_REQUIRED", "").status).toBe(422);
  });

  it.each([
    ["ALREADY_EXISTS", 10201],
    ["IMPORT_IN_PROGRESS", 10302],
    ["FORK_IN_PROGRESS", 10303],
    ["INVALID_INPUT", 10100],
    ["INVALID_REPO_NAME", 10101],
    ["INVALID_TTL", 10103],
    ["INVALID_URL", 10104],
    ["REMOTE_AUTH_REQUIRED", 10106],
    ["UPSTREAM_UNAVAILABLE", 10401],
    ["MEMORY_LIMIT", 10402],
    ["INTERNAL_ERROR", 10400],
  ] as const)("%s maps to %i and back", (code, numeric) => {
    expect(new ArtifactsError(code, "").numericCode).toBe(numeric);
    expect(codeFromNumeric(numeric)).toBe(code);
  });

  it("returns undefined for an unknown numeric code", () => {
    expect(codeFromNumeric(1)).toBeUndefined();
  });
});

describe("names", () => {
  it.each(["default", "a1", "my-ns", "a.b_c-d", "0abc", "x".repeat(63)])("accepts namespace %s", (n) => {
    expect(isValidNamespaceName(n)).toBe(true);
    expect(assertNamespaceName(n)).toBe(n);
  });

  it.each(["a", "x".repeat(64), "-a", ".a", "_a", "a/b", "a b", "ä1", "", 5, null])(
    "rejects namespace %s with INVALID_INPUT",
    (n) => {
      expect(isValidNamespaceName(n)).toBe(false);
      expect(() => assertNamespaceName(n)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );

  it("accepts a one-character repo name", () => {
    expect(isValidRepoName("a")).toBe(true);
    expect(assertRepoName("a")).toBe("a");
  });

  it.each(["", "-a", "a/b", "a..b/", "x".repeat(64), undefined])("rejects repo %s with INVALID_REPO_NAME", (n) => {
    expect(() => assertRepoName(n)).toThrowError(expect.objectContaining({ code: "INVALID_REPO_NAME" }));
  });

  it("validates object hashes", () => {
    const h = "0123456789abcdef0123456789abcdef01234567";
    expect(assertHash(h)).toBe(h);
    for (const bad of [h.toUpperCase(), h.slice(1), `${h}0`, "", 42]) {
      expect(() => assertHash(bad)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});
