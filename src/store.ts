import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactsError } from "./errors.ts";
import { EventBus } from "./events.ts";
import { countObjects, git, gitOk } from "./git.ts";
import { assertNamespaceName, assertRepoName } from "./names.ts";
import {
  type Scope,
  type TokenInfo,
  type TokenRecord,
  type TokenState,
  hashSecret,
  issueToken,
  newId,
  parseSecret,
  resolveScope,
  resolveTtl,
  scopeAllows,
  toTokenInfo,
  tokenState,
} from "./tokens.ts";

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
}

/** Hooks shipped with the package; see hooks/pre-receive. */
export const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");

/** Documented per-file limit. */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;

const SORT_FIELDS: Record<RepoSort, keyof RepoMeta> = {
  created_at: "createdAt",
  updated_at: "updatedAt",
  last_push_at: "lastPushAt",
  name: "name",
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { o: unknown };
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {}
  throw new ArtifactsError("INVALID_INPUT", "Invalid cursor");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Store {
  readonly dataDir: string;
  readonly events: EventBus;
  readonly now: () => number;
  readonly asyncDelayMs: number;
  readonly allowInsecureImport: boolean;
  readonly maxBlobBytes: number;
  /** Base for `remote` URLs, e.g. http://127.0.0.1:8788. Set by the server once it listens. */
  publicUrl = "http://127.0.0.1:8788";

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
    this.events = opts.events ?? new EventBus(opts.accountId ?? "local", this.now);
    this.asyncDelayMs = opts.asyncDelayMs ?? 0;
    this.allowInsecureImport = opts.allowInsecureImport ?? false;
    this.maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_BYTES;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ── paths ──

  namespaceDir(ns: string): string {
    return join(this.dataDir, assertNamespaceName(ns));
  }

  gitDir(ns: string, repo: string): string {
    return join(this.namespaceDir(ns), "repos", `${assertRepoName(repo)}.git`);
  }

  private metaPath(ns: string, repo: string): string {
    return join(this.gitDir(ns, repo), "artifacts-meta.json");
  }

  private tokensPath(ns: string, repo: string): string {
    return join(this.gitDir(ns, repo), "artifacts-tokens.json");
  }

  remoteUrl(ns: string, repo: string): string {
    return `${this.publicUrl}/git/${ns}/${repo}.git`;
  }

  // ── namespaces ──

  async createNamespace(name: unknown, jurisdiction?: unknown): Promise<NamespaceMeta> {
    const ns = assertNamespaceName(name);
    if (jurisdiction !== undefined && jurisdiction !== null && jurisdiction !== "eu" && jurisdiction !== "us") {
      throw new ArtifactsError("INVALID_INPUT", 'Invalid option: expected one of "eu"|"us"', "/jurisdiction");
    }
    await mkdir(this.dataDir, { recursive: true });
    try {
      await mkdir(this.namespaceDir(ns));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ArtifactsError("ALREADY_EXISTS", "Namespace already exists");
      }
      throw e;
    }
    const at = this.iso();
    const meta: NamespaceMeta = { name: ns, jurisdiction: (jurisdiction as Jurisdiction) ?? null, createdAt: at, updatedAt: at };
    await writeJson(join(this.namespaceDir(ns), "namespace.json"), meta);
    return meta;
  }

  /** Repo creation auto-creates its namespace, as the docs describe. */
  private async ensureNamespace(ns: string): Promise<void> {
    if (await exists(join(this.namespaceDir(ns), "namespace.json"))) return;
    try {
      await this.createNamespace(ns);
    } catch (e) {
      if (!(e instanceof ArtifactsError && e.code === "ALREADY_EXISTS")) throw e;
    }
  }

  async getNamespace(name: unknown): Promise<NamespaceMeta> {
    const ns = assertNamespaceName(name);
    const meta = await readJson<NamespaceMeta>(join(this.namespaceDir(ns), "namespace.json"));
    if (!meta) throw new ArtifactsError("NOT_FOUND", "Namespace not found");
    return meta;
  }

  async listNamespaces(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: NamespaceMeta[]; total: number; nextCursor?: string }> {
    const limit = opts.limit ?? 50;
    const offset = decodeCursor(opts.cursor);
    let names: string[] = [];
    try {
      names = (await readdir(this.dataDir)).sort();
    } catch {}
    const all: NamespaceMeta[] = [];
    for (const n of names) {
      const meta = await readJson<NamespaceMeta>(join(this.dataDir, n, "namespace.json"));
      if (meta) all.push(meta);
    }
    const items = all.slice(offset, offset + limit);
    return { items, total: all.length, nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : undefined };
  }

  /** Number of repos in a namespace (REST `repo_count`). */
  async countRepos(name: unknown): Promise<number> {
    const ns = assertNamespaceName(name);
    try {
      return (await readdir(join(this.namespaceDir(ns), "repos"))).filter((e) => e.endsWith(".git")).length;
    } catch {
      return 0;
    }
  }

  async deleteNamespace(name: unknown): Promise<void> {
    const ns = assertNamespaceName(name);
    await this.getNamespace(ns);
    await rm(this.namespaceDir(ns), { recursive: true, force: true });
  }

  // ── repo metadata ──

  async readMeta(ns: string, repo: string): Promise<RepoMeta | null> {
    return readJson<RepoMeta>(this.metaPath(ns, repo));
  }

  private async writeMeta(meta: RepoMeta): Promise<void> {
    await writeJson(this.metaPath(meta.namespace, meta.name), meta);
  }

  /** Metadata of a repo that exists and is ready; throws NOT_FOUND / *_IN_PROGRESS otherwise. */
  async getReadyRepo(ns: string, repo: string): Promise<RepoMeta> {
    assertNamespaceName(ns);
    assertRepoName(repo);
    const meta = await this.readMeta(ns, repo);
    if (!meta) throw new ArtifactsError("NOT_FOUND", "Repository not found");
    if (meta.status === "forking") throw new ArtifactsError("FORK_IN_PROGRESS", `Repository ${repo} is still being forked`);
    if (meta.status === "importing") throw new ArtifactsError("IMPORT_IN_PROGRESS", `Repository ${repo} is still being imported`);
    return meta;
  }

  /** Reserve a repo directory atomically: concurrent creates of one name yield one ALREADY_EXISTS. */
  private async reserve(ns: string, repo: string): Promise<string> {
    assertRepoName(repo);
    await this.ensureNamespace(ns);
    await mkdir(join(this.namespaceDir(ns), "repos"), { recursive: true });
    const dir = this.gitDir(ns, repo);
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ArtifactsError("ALREADY_EXISTS", `repo already exists: ${repo}`);
      }
      throw e;
    }
    return dir;
  }

  private newMeta(ns: string, repo: string, fields: Partial<RepoMeta>): RepoMeta {
    const at = this.iso();
    return {
      id: newId(),
      name: repo,
      namespace: ns,
      description: null,
      defaultBranch: "main",
      createdAt: at,
      updatedAt: at,
      lastPushAt: null,
      source: null,
      readOnly: false,
      status: "ready",
      ...fields,
    };
  }

  private eventPayload(meta: RepoMeta): Record<string, unknown> {
    return {
      repoId: meta.id,
      defaultBranch: meta.defaultBranch,
      description: meta.description,
      readOnly: meta.readOnly,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastPushAt: meta.lastPushAt,
    };
  }

  /** Initial token handed back by create, fork, and import (write scope, default TTL). */
  private async initialToken(meta: RepoMeta): Promise<string> {
    const { plaintext } = await this.createToken(meta.namespace, meta.name, "write", undefined);
    return plaintext;
  }

  // ── create / delete ──

  async createRepo(
    nsName: unknown,
    repoName: unknown,
    opts: { description?: string | null; defaultBranch?: string; readOnly?: boolean } = {},
  ): Promise<CreatedRepo> {
    const ns = assertNamespaceName(nsName);
    const repo = assertRepoName(repoName);
    const defaultBranch = opts.defaultBranch ?? "main";
    const branchOk = await git(["check-ref-format", "--branch", defaultBranch]);
    if (branchOk.code !== 0 || defaultBranch.startsWith("-")) {
      throw new ArtifactsError("INVALID_INPUT", `Invalid default branch: ${JSON.stringify(defaultBranch)}`);
    }
    const dir = await this.reserve(ns, repo);
    try {
      await gitOk(["init", "-q", "--bare", "-b", defaultBranch, dir]);
      await this.configureRepo(dir);
      const meta = this.newMeta(ns, repo, {
        description: opts.description ?? null,
        defaultBranch,
        readOnly: opts.readOnly ?? false,
      });
      await this.writeMeta(meta);
      await writeJson(this.tokensPath(ns, repo), []);
      this.events.emit("cf.artifacts.repo.created", ns, repo, this.eventPayload(meta));
      const token = await this.initialToken(meta);
      return { meta, token };
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /** Server-side git settings that match the documented protocol support. */
  private async configureRepo(dir: string): Promise<void> {
    const set = (k: string, v: string) => gitOk(["--git-dir", dir, "config", k, v]);
    await set("http.receivepack", "true");
    await set("uploadpack.allowFilter", "false");
    await set("receive.denyDeleteCurrent", "false");
    await set("core.logAllRefUpdates", "false");
  }

  private tombstonesPath(ns: string): string {
    return join(this.namespaceDir(ns), "deleted.json");
  }

  /** ID of a repo that was deleted under this name, if any. Live REST answers 202 to a repeat delete. */
  async deletedRepoId(nsName: unknown, repoName: unknown): Promise<string | null> {
    const ns = assertNamespaceName(nsName);
    const repo = assertRepoName(repoName);
    return (await readJson<Record<string, string>>(this.tombstonesPath(ns)))?.[repo] ?? null;
  }

  async deleteRepo(nsName: unknown, repoName: unknown): Promise<RepoMeta | null> {
    const ns = assertNamespaceName(nsName);
    const repo = assertRepoName(repoName);
    const meta = await this.readMeta(ns, repo);
    if (!meta) return null;
    await rm(this.gitDir(ns, repo), { recursive: true, force: true });
    const tombstones = (await readJson<Record<string, string>>(this.tombstonesPath(ns))) ?? {};
    tombstones[repo] = meta.id;
    await writeJson(this.tombstonesPath(ns), tombstones);
    this.events.emit("cf.artifacts.repo.deleted", ns, repo, this.eventPayload(meta));
    return meta;
  }

  // ── list ──

  async listRepos(nsName: unknown, opts: ListReposOptions = {}): Promise<{ repos: RepoMeta[]; total: number; nextCursor?: string }> {
    const ns = assertNamespaceName(nsName);
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ArtifactsError(
        "INVALID_INPUT",
        limit < 1 ? "Too small: expected number to be >0" : "Too big: expected number to be <=200",
        "/limit",
      );
    }
    const sort = opts.sort ?? "created_at";
    if (!(sort in SORT_FIELDS)) {
      throw new ArtifactsError(
        "INVALID_INPUT",
        'Invalid option: expected one of "created_at"|"updated_at"|"last_push_at"|"name"',
        "/sort",
      );
    }
    const direction = opts.direction ?? "desc";
    if (direction !== "asc" && direction !== "desc") {
      throw new ArtifactsError("INVALID_INPUT", 'Invalid option: expected one of "asc"|"desc"', "/direction");
    }
    const offset = decodeCursor(opts.cursor);

    let entries: string[] = [];
    try {
      entries = await readdir(join(this.namespaceDir(ns), "repos"));
    } catch {}
    let all: RepoMeta[] = [];
    for (const e of entries) {
      if (!e.endsWith(".git")) continue;
      const meta = await this.readMeta(ns, e.slice(0, -4));
      if (meta) all.push(meta);
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      all = all.filter((m) => m.name.toLowerCase().includes(q));
    }
    const field = SORT_FIELDS[sort];
    const sign = direction === "asc" ? 1 : -1;
    all.sort((a, b) => {
      const av = a[field] ?? "";
      const bv = b[field] ?? "";
      if (av < bv) return -sign;
      if (av > bv) return sign;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const repos = all.slice(offset, offset + limit);
    return {
      repos,
      total: all.length,
      nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : undefined,
    };
  }

  // ── fork / import ──

  /**
   * Publish `meta` in its in-progress state, build the repo in a temp dir, then swap it in.
   * While building, get() sees FORK_IN_PROGRESS / IMPORT_IN_PROGRESS rather than NOT_FOUND.
   */
  private async materialize(dir: string, meta: RepoMeta, build: (tmp: string) => Promise<void>): Promise<RepoMeta> {
    const tmp = `${dir}.build-${newId()}`;
    try {
      await this.writeMeta(meta);
      await build(tmp);
      if (this.asyncDelayMs) await sleep(this.asyncDelayMs);
      await this.configureRepo(tmp);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      const ready: RepoMeta = { ...meta, status: "ready", updatedAt: this.iso() };
      await this.writeMeta(ready);
      await writeJson(this.tokensPath(meta.namespace, meta.name), []);
      return ready;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }

  async forkRepo(
    nsName: unknown,
    repoName: unknown,
    targetName: unknown,
    opts: { description?: string | null; readOnly?: boolean; defaultBranchOnly?: boolean } = {},
  ): Promise<CreatedRepo> {
    const ns = assertNamespaceName(nsName);
    const src = await this.getReadyRepo(ns, assertRepoName(repoName));
    const target = assertRepoName(targetName);
    const dir = await this.reserve(ns, target);
    const srcDir = this.gitDir(ns, src.name);
    const meta = this.newMeta(ns, target, {
      description: opts.description ?? src.description,
      defaultBranch: src.defaultBranch,
      readOnly: opts.readOnly ?? false,
      source: `artifacts:${ns}/${src.name}`,
      status: "forking",
    });
    const ready = await this.materialize(dir, meta, async (tmp) => {
      const hasCommits = (await git(["--git-dir", srcDir, "rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
      if (!hasCommits) {
        await gitOk(["init", "-q", "--bare", "-b", src.defaultBranch, tmp]);
        return;
      }
      const branchArgs = (opts.defaultBranchOnly ?? true) ? ["--single-branch", "--branch", src.defaultBranch] : [];
      await gitOk(["clone", "-q", "--bare", ...branchArgs, srcDir, tmp]);
      await gitOk(["--git-dir", tmp, "remote", "remove", "origin"]);
    });
    const objects = await countObjects(dir);
    this.events.emit("cf.artifacts.repo.forked", ns, src.name, {
      namespace: ns,
      repoName: target,
      ...this.eventPayload(ready),
    });
    const token = await this.initialToken(ready);
    return { meta: ready, token, objects };
  }

  async importRepo(
    nsName: unknown,
    repoName: unknown,
    params: { url: unknown; branch?: string; depth?: number; description?: string | null; readOnly?: boolean },
  ): Promise<CreatedRepo> {
    const ns = assertNamespaceName(nsName);
    const target = assertRepoName(repoName);
    const url = params.url;
    if (typeof url !== "string" || !url) throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
    if (!this.allowInsecureImport && !/^https:\/\//.test(url)) {
      throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
    }
    if (params.depth !== undefined && (!Number.isInteger(params.depth) || params.depth < 1)) {
      throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/depth");
    }
    if (params.branch !== undefined && (typeof params.branch !== "string" || !params.branch || params.branch.startsWith("-"))) {
      throw new ArtifactsError("INVALID_INPUT", "Invalid branch", "/branch");
    }
    const dir = await this.reserve(ns, target);
    const meta = this.newMeta(ns, target, {
      description: params.description ?? null,
      readOnly: params.readOnly ?? false,
      source: importSource(url),
      status: "importing",
    });
    let head = "main";
    const ready = await this.materialize(dir, meta, async (tmp) => {
      const args = ["clone", "-q", "--bare", "--single-branch"];
      if (params.branch) args.push("--branch", params.branch);
      if (params.depth) args.push("--depth", String(params.depth));
      const r = await git([...args, "--end-of-options", url, tmp]);
      if (r.code !== 0) throw importError(r.stderr, url.endsWith(".git") ? url : `${url}.git`);
      await gitOk(["--git-dir", tmp, "remote", "remove", "origin"]);
      head = (await gitOk(["--git-dir", tmp, "symbolic-ref", "--short", "HEAD"])).toString().trim();
    });
    const final: RepoMeta = { ...ready, defaultBranch: head };
    await this.writeMeta(final);
    this.events.emit("cf.artifacts.repo.imported", ns, target, {
      ...this.eventPayload(final),
      sourceUrl: url,
      branch: head,
    });
    const token = await this.initialToken(final);
    return { meta: final, token };
  }

  // ── push bookkeeping (called by the git HTTP layer) ──

  async recordPush(ns: string, repo: string): Promise<void> {
    const meta = await this.readMeta(ns, repo);
    if (!meta) return;
    const at = this.iso();
    await this.writeMeta({ ...meta, updatedAt: at, lastPushAt: at });
  }

  // ── tokens ──

  private async readTokens(ns: string, repo: string): Promise<TokenRecord[]> {
    return (await readJson<TokenRecord[]>(this.tokensPath(ns, repo))) ?? [];
  }

  async createToken(ns: string, repo: string, scope: unknown, ttl: unknown): Promise<{ info: TokenInfo; plaintext: string }> {
    // Validate the request before looking the repo up, as a schema-validating API would.
    resolveScope(scope);
    resolveTtl(ttl);
    await this.getReadyRepo(ns, repo);
    const { record, plaintext } = issueToken(scope, ttl, this.now());
    const tokens = await this.readTokens(ns, repo);
    tokens.push(record);
    await writeJson(this.tokensPath(ns, repo), tokens);
    this.events.emit("cf.artifacts.repo.token.created", ns, repo, {
      tokenId: record.id,
      scope: record.scope,
      expiresAt: record.expiresAt,
    });
    return { info: toTokenInfo(record, this.now()), plaintext };
  }

  async listTokens(ns: string, repo: string, state: TokenState | "all" = "all"): Promise<TokenInfo[]> {
    await this.getReadyRepo(ns, repo);
    const now = this.now();
    return (await this.readTokens(ns, repo))
      .map((r) => toTokenInfo(r, now))
      .filter((t) => state === "all" || t.state === state);
  }

  /** Revoke by token id or plaintext. Returns false when no token matches. */
  async revokeToken(ns: string, repo: string, tokenOrId: unknown): Promise<boolean> {
    if (typeof tokenOrId !== "string" || !tokenOrId) {
      throw new ArtifactsError("INVALID_INPUT", "tokenOrId must be a non-empty string");
    }
    const tokens = await this.readTokens(ns, repo);
    const secret = parseSecret(tokenOrId);
    const hash = secret ? hashSecret(secret) : null;
    const t = tokens.find((r) => r.id === tokenOrId || (hash !== null && r.secretHash === hash));
    if (!t || t.revokedAt) return false;
    t.revokedAt = this.iso();
    await writeJson(this.tokensPath(ns, repo), tokens);
    this.events.emit("cf.artifacts.repo.token.revoked", ns, repo, { tokenId: t.id });
    return true;
  }

  /**
   * REST revokes by id within a namespace, without naming the repo. "missing" when no repo in the
   * namespace has the token; revoking an already revoked token is not an error (live behaviour).
   */
  async revokeTokenById(nsName: unknown, id: unknown): Promise<"revoked" | "already-revoked" | "missing"> {
    const ns = assertNamespaceName(nsName);
    let cursor: string | undefined;
    do {
      const page = await this.listRepos(ns, { limit: 200, cursor });
      for (const m of page.repos) {
        if (await this.revokeToken(ns, m.name, id)) return "revoked";
        if ((await this.readTokens(ns, m.name)).some((t) => t.id === id)) return "already-revoked";
      }
      cursor = page.nextCursor;
    } while (cursor);
    return "missing";
  }

  /** Check a presented secret against a repo's tokens. Returns the granted scope or null. */
  async authenticate(ns: string, repo: string, presented: string, needed: Scope): Promise<"ok" | "unauthorized" | "forbidden"> {
    const secret = parseSecret(presented);
    if (!secret) return "unauthorized";
    const hash = hashSecret(secret);
    const now = this.now();
    const t = (await this.readTokens(ns, repo)).find((r) => r.secretHash === hash);
    if (!t || tokenState(t, now) !== "active") return "unauthorized";
    return scopeAllows(t.scope, needed) ? "ok" : "forbidden";
  }
}

/** `github:owner/repo` for GitHub, as in the types' example; the URL otherwise. */
export function importSource(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `github:${m[1]}/${m[2]}` : url;
}

export function importError(stderr: string, url = ""): ArtifactsError {
  const s = stderr.toLowerCase();
  if (/could not read username|authentication failed|terminal prompts disabled|401|403/.test(s)) {
    return new ArtifactsError(
      "REMOTE_AUTH_REQUIRED",
      `Repository "${url}" requires authentication (HTTP 401). Only public repositories can be imported.`,
      "/url",
    );
  }
  if (/could not resolve host|failed to connect|connection refused|timed out|unable to access/.test(s)) {
    return new ArtifactsError("UPSTREAM_UNAVAILABLE", "The remote git server could not be reached", "/url");
  }
  if (/not found|does not exist|404/.test(s)) {
    return new ArtifactsError("NOT_FOUND", "The remote repository does not exist", "/url");
  }
  return new ArtifactsError("INVALID_URL", "url must be an HTTPS git remote URL (e.g. https://github.com/owner/repo)", "/url");
}
