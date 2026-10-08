import { ArtifactsError } from "./errors.ts";

// Docs (Limits): start with a letter or digit, then letters, digits, `.`, `_`, `-`.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidNamespaceName(name: unknown): name is string {
  return typeof name === "string" && name.length >= 2 && name.length <= 63 && NAME.test(name);
}

// Repo name length is undocumented; 63 mirrors the namespace limit.
export function isValidRepoName(name: unknown): name is string {
  return typeof name === "string" && name.length >= 1 && name.length <= 63 && NAME.test(name);
}

export function assertNamespaceName(name: unknown): string {
  if (!isValidNamespaceName(name)) {
    throw new ArtifactsError("INVALID_INPUT", "Invalid namespace name", "/namespace");
  }
  return name;
}

export function assertRepoName(name: unknown): string {
  if (!isValidRepoName(name)) {
    throw new ArtifactsError("INVALID_REPO_NAME", "Invalid repo name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/", "/name");
  }
  return name;
}

const HASH = /^[0-9a-f]{40}$/;

export function assertHash(hash: unknown): string {
  if (typeof hash !== "string" || !HASH.test(hash)) {
    throw new ArtifactsError("INVALID_INPUT", "Invalid SHA-1 hash", "/hash");
  }
  return hash;
}
