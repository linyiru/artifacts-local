import { ArtifactsError } from "./errors.js";
import { EventBus } from "./events.js";
import { type Scope, type TokenInfo, type TokenState } from "./tokens.js";
export type RepoStatus = "ready" | "forking" | "importing";
export type Jurisdiction = "eu" | "us";
export interface RepoMeta {
    id: string;
    name: string;
    namespace: string;
    description: string | null;
    defaultBranch: string;
    createdAt: string;
    updatedAt: string;
    lastPushAt: string | null;
    source: string | null;
    readOnly: boolean;
    status: RepoStatus;
}
export interface NamespaceMeta {
    name: string;
    jurisdiction: Jurisdiction | null;
    createdAt: string;
    updatedAt?: string;
}
export interface CreatedRepo {
    meta: RepoMeta;
    token: string;
    objects?: number;
}
export type RepoSort = "created_at" | "updated_at" | "last_push_at" | "name";
export interface ListReposOptions {
    limit?: number;
    cursor?: string;
    search?: string;
    sort?: RepoSort;
    direction?: "asc" | "desc";
}
export interface StoreOptions {
    dataDir: string;
    accountId?: string;
    events?: EventBus;
    now?: () => number;
    /** Hold forks and imports in their in-progress state this long (ms) to exercise retry paths. */
    asyncDelayMs?: number;
    /** Allow import from non-HTTPS sources (file paths, http://). Off by default, like the real service. */
    allowInsecureImport?: boolean;
    /** Largest file a push may carry. Defaults to the documented 32 MB. */
    maxBlobBytes?: number;
    /**
     * Update `last_push_at` / `updated_at` on push. Off by default: the live service left both
     * unchanged after pushes (checked 2026-10-08, 15 s after the push).
     */
    trackPushTimes?: boolean;
}
/** Hooks shipped with the package; see hooks/pre-receive. */
export declare const HOOKS_DIR: string;
/** Documented per-file limit. */
export declare const MAX_BLOB_BYTES: number;
export declare class Store {
    readonly dataDir: string;
    readonly events: EventBus;
    readonly now: () => number;
    readonly asyncDelayMs: number;
    readonly allowInsecureImport: boolean;
    readonly maxBlobBytes: number;
    readonly trackPushTimes: boolean;
    /** Base for `remote` URLs, e.g. http://127.0.0.1:8788. Set by the server once it listens. */
    publicUrl: string;
    constructor(opts: StoreOptions);
    private iso;
    namespaceDir(ns: string): string;
    gitDir(ns: string, repo: string): string;
    private metaPath;
    private tokensPath;
    remoteUrl(ns: string, repo: string): string;
    createNamespace(name: unknown, jurisdiction?: unknown): Promise<NamespaceMeta>;
    /** Repo creation auto-creates its namespace, as the docs describe. */
    private ensureNamespace;
    getNamespace(name: unknown): Promise<NamespaceMeta>;
    listNamespaces(opts?: {
        limit?: number;
        cursor?: string;
    }): Promise<{
        items: NamespaceMeta[];
        total: number;
        nextCursor?: string;
    }>;
    /** Number of repos in a namespace (REST `repo_count`). */
    countRepos(name: unknown): Promise<number>;
    deleteNamespace(name: unknown): Promise<void>;
    readMeta(ns: string, repo: string): Promise<RepoMeta | null>;
    private writeMeta;
    /** Metadata of a repo that exists and is ready; throws NOT_FOUND / *_IN_PROGRESS otherwise. */
    getReadyRepo(ns: string, repo: string): Promise<RepoMeta>;
    /** Reserve a repo directory atomically: concurrent creates of one name yield one ALREADY_EXISTS. */
    private reserve;
    private newMeta;
    private eventPayload;
    /** Initial token handed back by create, fork, and import (write scope, default TTL). */
    private initialToken;
    createRepo(nsName: unknown, repoName: unknown, opts?: {
        description?: string | null;
        defaultBranch?: string;
        readOnly?: boolean;
    }): Promise<CreatedRepo>;
    /** Server-side git settings that match the documented protocol support. */
    private configureRepo;
    private tombstonesPath;
    /** ID of a repo that was deleted under this name, if any. Live REST answers 202 to a repeat delete. */
    deletedRepoId(nsName: unknown, repoName: unknown): Promise<string | null>;
    deleteRepo(nsName: unknown, repoName: unknown): Promise<RepoMeta | null>;
    listRepos(nsName: unknown, opts?: ListReposOptions): Promise<{
        repos: RepoMeta[];
        total: number;
        nextCursor?: string;
    }>;
    /**
     * Publish `meta` in its in-progress state, build the repo in a temp dir, then swap it in.
     * While building, get() sees FORK_IN_PROGRESS / IMPORT_IN_PROGRESS rather than NOT_FOUND.
     */
    private materialize;
    forkRepo(nsName: unknown, repoName: unknown, targetName: unknown, opts?: {
        description?: string | null;
        readOnly?: boolean;
        defaultBranchOnly?: boolean;
    }): Promise<CreatedRepo>;
    importRepo(nsName: unknown, repoName: unknown, params: {
        url: unknown;
        branch?: string;
        depth?: number;
        description?: string | null;
        readOnly?: boolean;
    }): Promise<CreatedRepo>;
    recordPush(ns: string, repo: string): Promise<void>;
    private readTokens;
    createToken(ns: string, repo: string, scope: unknown, ttl: unknown): Promise<{
        info: TokenInfo;
        plaintext: string;
    }>;
    listTokens(ns: string, repo: string, state?: TokenState | "all"): Promise<TokenInfo[]>;
    /** Revoke by token id or plaintext. Returns false when no token matches. */
    revokeToken(ns: string, repo: string, tokenOrId: unknown): Promise<boolean>;
    /**
     * REST revokes by id within a namespace, without naming the repo. "missing" when no repo in the
     * namespace has the token; revoking an already revoked token is not an error (live behaviour).
     */
    revokeTokenById(nsName: unknown, id: unknown): Promise<"revoked" | "already-revoked" | "missing">;
    /** Check a presented secret against a repo's tokens. Returns the granted scope or null. */
    authenticate(ns: string, repo: string, presented: string, needed: Scope): Promise<"ok" | "unauthorized" | "forbidden">;
}
/** Live: `git:<url>`, with `.git` appended when missing (`git:https://github.com/o/r.git`). */
export declare function importSource(url: string): string;
export declare function importError(stderr: string, url?: string): ArtifactsError;
