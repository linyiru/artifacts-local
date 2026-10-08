import { spawn } from "node:child_process";
import { ArtifactsError } from "./errors.ts";
import { assertHash } from "./names.ts";

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  input?: Buffer | string;
  env?: Record<string, string>;
}

/** Keep the user's global/system git config (hooks, signing, aliases) out of the emulator. */
export const ISOLATED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export function git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...ISOLATED_GIT_ENV, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
    });
    // Many git commands never read stdin and may exit before we write; the exit code is the
    // real result, so a broken pipe here is not an error.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run git and throw INTERNAL_ERROR on a non-zero exit. */
export async function gitOk(args: string[], opts: GitOptions = {}): Promise<Buffer> {
  const r = await git(args, opts);
  if (r.code !== 0) {
    throw new ArtifactsError("INTERNAL_ERROR", `git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface RawObject {
  hash: string;
  type: ObjectType;
  data: Buffer;
}

/** Read many objects in one `git cat-file --batch`. Missing objects map to null. */
export async function readObjects(gitDir: string, hashes: string[]): Promise<(RawObject | null)[]> {
  if (hashes.length === 0) return [];
  const out = await gitOk(["--git-dir", gitDir, "cat-file", "--batch"], { input: `${hashes.join("\n")}\n` });
  const results: (RawObject | null)[] = [];
  let pos = 0;
  for (let i = 0; i < hashes.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, nl).toString();
    pos = nl + 1;
    if (header.endsWith(" missing")) {
      results.push(null);
      continue;
    }
    const [hash, type, size] = header.split(" ") as [string, ObjectType, string];
    const len = Number(size);
    results.push({ hash, type, data: out.subarray(pos, pos + len) });
    pos += len + 1;
  }
  return results;
}

export async function readObject(gitDir: string, hash: string): Promise<RawObject | null> {
  const [obj] = await readObjects(gitDir, [hash]);
  return obj ?? null;
}

function assertRef(ref: string): void {
  // Refs never start with "-"; refusing them keeps a ref from being parsed as a git option.
  if (ref.startsWith("-") || ref.includes("\0")) {
    throw new ArtifactsError("INVALID_INPUT", `Invalid ref: ${JSON.stringify(ref)}`);
  }
}

/** Resolve a branch, tag, or commit ID to a commit hash; null if it does not resolve. */
export async function resolveCommit(gitDir: string, ref: string): Promise<string | null> {
  assertRef(ref);
  const r = await git(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.toString().trim() : null;
}

export interface Identity {
  name: string;
  email: string;
}

export interface CommitMetadata {
  hash: string;
  treeHash: string;
  message: string;
  author: Identity;
  committer: Identity;
  parents: string[];
  authoredAt: number;
  committedAt: number;
}

function parseIdentity(value: string): { who: Identity; at: number } {
  const m = /^(.*?) <([^>]*)> (-?\d+) [+-]\d{4}$/.exec(value);
  if (!m) return { who: { name: value, email: "" }, at: 0 };
  return { who: { name: m[1]!, email: m[2]! }, at: Number(m[3]) };
}

export function parseCommit(hash: string, data: Buffer): CommitMetadata {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? "" : text.slice(split + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);

  let treeHash = "";
  const parents: string[] = [];
  let author = { who: { name: "", email: "" }, at: 0 };
  let committer = author;
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header (gpgsig, mergetag)
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") treeHash = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parseIdentity(value);
    else if (key === "committer") committer = parseIdentity(value);
  }
  return {
    hash,
    treeHash,
    message,
    author: author.who,
    committer: committer.who,
    parents,
    authoredAt: author.at,
    committedAt: committer.at,
  };
}

export async function readCommit(gitDir: string, hash: string): Promise<CommitMetadata | null> {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  if (!obj) return null;
  if (obj.type !== "commit") throw new ArtifactsError("INTERNAL_ERROR", `Object ${hash} is not a commit`);
  return parseCommit(hash, obj.data);
}

export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
  type: TreeEntryType;
}

const MODE_TYPES: Record<string, TreeEntryType> = {
  "40000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

/** Parse the binary tree format: `<mode> <name>\0<20-byte id>` repeated. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(pos, sp).toString();
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const hash = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ name, mode, hash, type: MODE_TYPES[mode] ?? "blob" });
    pos = nul + 21;
  }
  return entries;
}

export async function readTree(gitDir: string, hash: string): Promise<TreeEntry[] | null> {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  if (!obj) return null;
  if (obj.type !== "tree") throw new ArtifactsError("INTERNAL_ERROR", "A stored git object is corrupt.");
  return parseTree(obj.data);
}

export async function readBlob(gitDir: string, hash: string): Promise<Buffer | null> {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  return obj && obj.type === "blob" ? obj.data : null;
}

/** Resolve `path` at `ref` to blob bytes; null for a missing ref, missing path, or a directory. */
export async function readFileAt(gitDir: string, ref: string, path: string): Promise<Buffer | null> {
  if (!ref) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected string, received undefined", "/ref");
  if (!path) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected string, received undefined", "/path");
  const commit = await resolveCommit(gitDir, ref);
  if (!commit) return null;
  const clean = path.replace(/^\/+/, "");
  if (!clean) return null;
  const r = await git([
    "--git-dir",
    gitDir,
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${commit}:${clean}`,
  ]);
  if (r.code !== 0) return null;
  return readBlob(gitDir, r.stdout.toString().trim());
}

/** The two types the docs list as tested: UTF-8 text, or opaque binary. */
export function sniffContentType(data: Buffer): string {
  if (data.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return "text/plain;charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}

export const LOG_DEFAULT_LIMIT = 50;
export const LOG_MAX_LIMIT = 1000;

export interface LogOptions {
  ref?: string;
  limit?: number;
  offset?: number;
}

export async function log(gitDir: string, opts: LogOptions = {}): Promise<CommitMetadata[]> {
  const ref = opts.ref ?? "HEAD";
  const limit = Math.min(opts.limit ?? LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1)
    throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/limit");
  if (!Number.isInteger(offset) || offset < 0)
    throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >=0", "/offset");

  const start = await resolveCommit(gitDir, ref);
  if (!start) return [];
  const list = await gitOk([
    "--git-dir",
    gitDir,
    "rev-list",
    "--first-parent",
    `--max-count=${limit}`,
    `--skip=${offset}`,
    start,
  ]);
  const hashes = list.toString().split("\n").filter(Boolean);
  const objects = await readObjects(gitDir, hashes);
  return objects.map((o, i) => parseCommit(hashes[i]!, o!.data));
}

export async function countObjects(gitDir: string): Promise<number> {
  const out = await gitOk(["--git-dir", gitDir, "count-objects", "-v"]);
  const get = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, "m").exec(out.toString())?.[1] ?? 0);
  return get("count") + get("in-pack");
}
