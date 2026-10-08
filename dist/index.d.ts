import { a as ArtifactsCreateRepoResult, c as ArtifactsRepoInfo, d as ArtifactsTokenListResult, f as ArtifactsTreeEntry, i as ArtifactsCommitMetadata, l as ArtifactsRepoListResult, n as createArtifactsBinding, o as ArtifactsCreateTokenResult, p as ArtifactsTreeEntryType, r as Artifacts, s as ArtifactsRepo, t as BindingOptions, u as ArtifactsTokenInfo } from "./client-En5OlMEC.js";
import { IncomingMessage, Server, ServerResponse } from "node:http";
//#region src/errors.d.ts
type ArtifactsErrorCode = "ALREADY_EXISTS" | "NOT_FOUND" | "CREATE_IN_PROGRESS" | "IMPORT_IN_PROGRESS" | "FORK_IN_PROGRESS" | "INVALID_INPUT" | "INVALID_REPO_NAME" | "INVALID_TTL" | "INVALID_URL" | "REMOTE_AUTH_REQUIRED" | "UPSTREAM_UNAVAILABLE" | "MEMORY_LIMIT" | "INTERNAL_ERROR";
export declare class ArtifactsError extends Error {
  #private;
  readonly name: "ArtifactsError";
  readonly code: ArtifactsErrorCode;
  readonly numericCode: number;
  /** `pointer` is the JSON pointer of the offending field, sent as REST `source.pointer`. */
  constructor(code: ArtifactsErrorCode, message: string, pointer?: string);
  get pointer(): string | undefined;
  /** The REST `errors[]` entry, shaped like the live service's. */
  toApiError(): {
    code: number;
    message: string;
    documentation_url: string;
    source?: {
      pointer: string;
    };
  };
  /** HTTP status for REST responses. A getter, so own keys match the real error: name, code, numericCode. */
  get status(): number;
}
export declare function isArtifactsError(err: unknown): err is ArtifactsError;
//#endregion
//#region src/subscriptions.d.ts
type SubscriptionSource = {
  type: "artifacts";
} | {
  type: "artifacts.repo";
  namespace: string;
  repo_name: string;
};
interface Subscription {
  id: string;
  name: string;
  enabled: boolean;
  queue: string;
  source: SubscriptionSource;
  events: string[];
  created_at: string;
}
interface QueueMessage {
  /** Position in this queue's feed; pull with `after` to resume. */
  seq: number;
  id: string;
  timestamp_ms: number;
  body: ArtifactsEvent;
}
declare class Subscriptions {
  private subs;
  private feeds;
  private seq;
  /** Changes when the emulator restarts and positions start over; consumers reset on a new epoch. */
  readonly epoch: string;
  private readonly now;
  private readonly maxPerQueue;
  constructor(now?: () => number, maxPerQueue?: number);
  create(queue: string, input: {
    name?: string;
    enabled?: boolean;
    source?: unknown;
    events?: unknown;
  }): Subscription;
  list(queue?: string): Subscription[];
  delete(id: string): boolean;
  /** Copy `event` into the feed of every enabled subscription it matches. */
  deliver(event: ArtifactsEvent): void;
  /** Messages in `queue` after position `after`, oldest first. */
  pull(queue: string, after?: number, limit?: number): {
    epoch: string;
    messages: QueueMessage[];
    next: number;
  };
}
//#endregion
//#region src/events.d.ts
type ArtifactsEventType = "cf.artifacts.repo.created" | "cf.artifacts.repo.deleted" | "cf.artifacts.repo.forked" | "cf.artifacts.repo.imported" | "cf.artifacts.repo.pushed" | "cf.artifacts.repo.cloned" | "cf.artifacts.repo.fetched" | "cf.artifacts.repo.token.created" | "cf.artifacts.repo.token.revoked";
interface ArtifactsEvent {
  type: ArtifactsEventType;
  source: {
    namespace: string;
    repoName: string;
    type: "artifacts" | "artifacts.repo";
  };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: 1;
    eventTimestamp: string;
  };
  payload: Record<string, unknown>;
}
type EventListener = (event: ArtifactsEvent) => void | Promise<void>;
export declare class EventBus {
  readonly accountId: string;
  readonly history: ArtifactsEvent[];
  readonly maxHistory: number;
  /** Event subscriptions; delivery is synchronous, so a message is queued when the operation ends. */
  readonly subscriptions: Subscriptions;
  private listeners;
  private now;
  constructor(accountId: string, now?: () => number, maxHistory?: number);
  subscribe(listener: EventListener): () => void;
  emit(type: ArtifactsEventType, namespace: string, repoName: string, payload: Record<string, unknown>): ArtifactsEvent;
}
/** POST each event as JSON to a URL, the local stand-in for a Queue consumer. */
export declare function webhookListener(url: string, fetchImpl?: typeof fetch): EventListener;
//#endregion
//#region src/metrics.d.ts
type EventKind = "action" | "error";
interface MetricEvent {
  datetime: string;
  repositoryNamespace: string;
  repositoryName: string;
  eventKind: EventKind;
  eventType: string;
  errorMessage: string;
  durationMs: number;
}
declare const DIMENSIONS: readonly ["repository", "repositoryNamespace", "repositoryName", "eventKind", "eventType", "errorMessage", "date", "datetime", "datetimeMinute", "datetimeFiveMinutes", "datetimeFifteenMinutes", "datetimeHour", "datetimeSixHours"];
type Dimension = (typeof DIMENSIONS)[number];
interface Filter {
  datetime_geq?: string;
  datetime_leq?: string;
  repository?: string;
  repositoryNamespace?: string;
  repositoryName?: string;
  eventKind?: EventKind;
  eventType?: string;
}
interface Group {
  count: number;
  sum: {
    durationMs: number;
  };
  avg: {
    durationMs: number;
  };
  quantiles: Record<"durationMsP25" | "durationMsP50" | "durationMsP75" | "durationMsP90" | "durationMsP95" | "durationMsP99" | "durationMsP999", number>;
  dimensions: Partial<Record<Dimension, string>>;
}
interface Operation {
  type: string;
  namespace: string;
  repo: string;
}
declare class Metrics {
  readonly events: MetricEvent[];
  private readonly now;
  private readonly max;
  constructor(now?: () => number, max?: number);
  /** Record an operation's outcome: an action, or clientError / serverError by HTTP status. */
  recordOperation(op: Operation, status: number, durationMs: number): void;
  record(e: Omit<MetricEvent, "datetime" | "errorMessage"> & {
    errorMessage?: string;
  }): void;
  /** Group matching events by `by`, like `artifactsEventsAdaptiveGroups`, ordered by count desc. */
  groups(filter?: Filter, by?: Dimension[], limit?: number): Group[];
}
//#endregion
//#region src/tokens.d.ts
type Scope = "read" | "write";
type TokenState = "active" | "expired" | "revoked";
interface TokenInfo {
  id: string;
  scope: Scope;
  state: TokenState;
  createdAt: string;
  expiresAt: string;
}
//#endregion
//#region src/store.d.ts
type RepoStatus = "ready" | "forking" | "importing";
type Jurisdiction = "eu" | "us";
interface RepoMeta {
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
interface NamespaceMeta {
  name: string;
  jurisdiction: Jurisdiction | null;
  createdAt: string;
  updatedAt?: string;
}
interface CreatedRepo {
  meta: RepoMeta;
  token: string;
  objects?: number;
}
type RepoSort = "created_at" | "updated_at" | "last_push_at" | "name";
interface ListReposOptions {
  limit?: number;
  cursor?: string;
  search?: string;
  sort?: RepoSort;
  direction?: "asc" | "desc";
}
interface StoreOptions {
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
export declare class Store {
  readonly dataDir: string;
  readonly events: EventBus;
  readonly metrics: Metrics;
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
  /** Bytes stored across every repo, the emulator's stand-in for billed storage. */
  storageBytes(): Promise<number>;
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
//#endregion
//#region src/binding-rpc.d.ts
export declare function handleBinding(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
//#endregion
//#region src/rest.d.ts
interface RestOptions {
  /** If set, REST calls must present exactly this bearer token. Otherwise any bearer is accepted. */
  apiToken?: string;
  /** If set, the account ID in the path must match. */
  accountId?: string;
}
//#endregion
//#region src/server.d.ts
interface ServerOptions extends RestOptions {
  dataDir: string;
  port?: number;
  host?: string;
  /** Base URL used in `remote` fields. Defaults to the listening address. */
  publicUrl?: string;
  /** POST every event to this URL (a local stand-in for an event subscription). */
  webhookUrl?: string;
  /** Event subscriptions to create at start, as `subscriptions.create(queue, …)` takes them. */
  subscriptions?: {
    queue: string;
    source: unknown;
    events?: string[];
  }[];
  asyncDelayMs?: number;
  allowInsecureImport?: boolean;
  maxBlobBytes?: number;
  trackPushTimes?: boolean;
  now?: () => number;
}
interface RunningServer {
  url: string;
  store: Store;
  server: Server;
  close(): Promise<void>;
}
/** Extra handlers mounted under the same server, e.g. the binding RPC endpoint. */
type Handler = (store: Store, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
export declare function startServer(opts: ServerOptions, extra?: Handler[]): Promise<RunningServer>;
//#endregion
export { type Artifacts, type ArtifactsCommitMetadata, type ArtifactsCreateRepoResult, type ArtifactsCreateTokenResult, type ArtifactsErrorCode, type ArtifactsEvent, type ArtifactsEventType, type ArtifactsRepo, type ArtifactsRepoInfo, type ArtifactsRepoListResult, type ArtifactsTokenInfo, type ArtifactsTokenListResult, type ArtifactsTreeEntry, type ArtifactsTreeEntryType, type BindingOptions, type Handler, type RunningServer, type ServerOptions, type StoreOptions, createArtifactsBinding };