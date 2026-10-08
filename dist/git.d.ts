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
export declare const ISOLATED_GIT_ENV: Record<string, string>;
export declare function git(args: string[], opts?: GitOptions): Promise<GitResult>;
/** Run git and throw INTERNAL_ERROR on a non-zero exit. */
export declare function gitOk(args: string[], opts?: GitOptions): Promise<Buffer>;
export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface RawObject {
    hash: string;
    type: ObjectType;
    data: Buffer;
}
/** Read many objects in one `git cat-file --batch`. Missing objects map to null. */
export declare function readObjects(gitDir: string, hashes: string[]): Promise<(RawObject | null)[]>;
export declare function readObject(gitDir: string, hash: string): Promise<RawObject | null>;
/** Resolve a branch, tag, or commit ID to a commit hash; null if it does not resolve. */
export declare function resolveCommit(gitDir: string, ref: string): Promise<string | null>;
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
export declare function parseCommit(hash: string, data: Buffer): CommitMetadata;
export declare function readCommit(gitDir: string, hash: string): Promise<CommitMetadata | null>;
export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";
export interface TreeEntry {
    name: string;
    mode: string;
    hash: string;
    type: TreeEntryType;
}
/** Parse the binary tree format: `<mode> <name>\0<20-byte id>` repeated. */
export declare function parseTree(data: Buffer): TreeEntry[];
export declare function readTree(gitDir: string, hash: string): Promise<TreeEntry[] | null>;
export declare function readBlob(gitDir: string, hash: string): Promise<Buffer | null>;
/** Resolve `path` at `ref` to blob bytes; null for a missing ref, missing path, or a directory. */
export declare function readFileAt(gitDir: string, ref: string, path: string): Promise<Buffer | null>;
/** The two types the docs list as tested: UTF-8 text, or opaque binary. */
export declare function sniffContentType(data: Buffer): string;
export declare const LOG_DEFAULT_LIMIT = 50;
export declare const LOG_MAX_LIMIT = 1000;
export interface LogOptions {
    ref?: string;
    limit?: number;
    offset?: number;
}
export declare function log(gitDir: string, opts?: LogOptions): Promise<CommitMetadata[]>;
export declare function countObjects(gitDir: string): Promise<number>;
