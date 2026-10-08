import {
  ArtifactsError
} from "./chunk-Q35FWRES.js";

// src/git.ts
import { spawn } from "node:child_process";

// src/names.ts
var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidNamespaceName(name) {
  return typeof name === "string" && name.length >= 2 && name.length <= 63 && NAME.test(name);
}
function isValidRepoName(name) {
  return typeof name === "string" && name.length >= 1 && name.length <= 63 && NAME.test(name);
}
function assertNamespaceName(name) {
  if (!isValidNamespaceName(name)) {
    throw new ArtifactsError("INVALID_INPUT", "Invalid namespace name", "/namespace");
  }
  return name;
}
function assertRepoName(name) {
  if (!isValidRepoName(name)) {
    throw new ArtifactsError("INVALID_REPO_NAME", "Invalid repo name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/", "/name");
  }
  return name;
}
var HASH = /^[0-9a-f]{40}$/;
function assertHash(hash) {
  if (typeof hash !== "string" || !HASH.test(hash)) {
    throw new ArtifactsError("INVALID_INPUT", "Invalid SHA-1 hash", "/hash");
  }
  return hash;
}

// src/git.ts
var ISOLATED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C"
};
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...ISOLATED_GIT_ENV, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
    });
    child.stdin.on("error", () => {
    });
    if (opts.input !== void 0) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
async function gitOk(args, opts = {}) {
  const r = await git(args, opts);
  if (r.code !== 0) {
    throw new ArtifactsError("INTERNAL_ERROR", `git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}
async function readObjects(gitDir, hashes) {
  if (hashes.length === 0) return [];
  const out = await gitOk(["--git-dir", gitDir, "cat-file", "--batch"], { input: `${hashes.join("\n")}
` });
  const results = [];
  let pos = 0;
  for (let i = 0; i < hashes.length; i++) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString();
    pos = nl + 1;
    if (header.endsWith(" missing")) {
      results.push(null);
      continue;
    }
    const [hash, type, size] = header.split(" ");
    const len = Number(size);
    results.push({ hash, type, data: out.subarray(pos, pos + len) });
    pos += len + 1;
  }
  return results;
}
async function readObject(gitDir, hash) {
  const [obj] = await readObjects(gitDir, [hash]);
  return obj ?? null;
}
function assertRef(ref) {
  if (ref.startsWith("-") || ref.includes("\0")) {
    throw new ArtifactsError("INVALID_INPUT", `Invalid ref: ${JSON.stringify(ref)}`);
  }
}
async function resolveCommit(gitDir, ref) {
  assertRef(ref);
  const r = await git(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.toString().trim() : null;
}
function parseIdentity(value) {
  const m = /^(.*?) <([^>]*)> (-?\d+) [+-]\d{4}$/.exec(value);
  if (!m) return { who: { name: value, email: "" }, at: 0 };
  return { who: { name: m[1], email: m[2] }, at: Number(m[3]) };
}
function parseCommit(hash, data) {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? "" : text.slice(split + 2);
  if (message.endsWith("\n")) message = message.slice(0, -1);
  let treeHash = "";
  const parents = [];
  let author = { who: { name: "", email: "" }, at: 0 };
  let committer = author;
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue;
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
    committedAt: committer.at
  };
}
async function readCommit(gitDir, hash) {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  if (!obj) return null;
  if (obj.type !== "commit") throw new ArtifactsError("INTERNAL_ERROR", `Object ${hash} is not a commit`);
  return parseCommit(hash, obj.data);
}
var MODE_TYPES = {
  "40000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink"
};
function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(32, pos);
    const nul = data.indexOf(0, sp);
    const mode = data.subarray(pos, sp).toString();
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const hash = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ name, mode, hash, type: MODE_TYPES[mode] ?? "blob" });
    pos = nul + 21;
  }
  return entries;
}
async function readTree(gitDir, hash) {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  if (!obj) return null;
  if (obj.type !== "tree") throw new ArtifactsError("INTERNAL_ERROR", "A stored git object is corrupt.");
  return parseTree(obj.data);
}
async function readBlob(gitDir, hash) {
  assertHash(hash);
  const obj = await readObject(gitDir, hash);
  return obj && obj.type === "blob" ? obj.data : null;
}
async function readFileAt(gitDir, ref, path) {
  if (!ref) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected string, received undefined", "/ref");
  if (!path) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected string, received undefined", "/path");
  const commit = await resolveCommit(gitDir, ref);
  if (!commit) return null;
  const clean = path.replace(/^\/+/, "");
  if (!clean) return null;
  const r = await git(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}:${clean}`]);
  if (r.code !== 0) return null;
  return readBlob(gitDir, r.stdout.toString().trim());
}
function sniffContentType(data) {
  if (data.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return "text/plain;charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}
var LOG_DEFAULT_LIMIT = 50;
var LOG_MAX_LIMIT = 1e3;
async function log(gitDir, opts = {}) {
  const ref = opts.ref ?? "HEAD";
  const limit = Math.min(opts.limit ?? LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/limit");
  if (!Number.isInteger(offset) || offset < 0) throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >=0", "/offset");
  const start = await resolveCommit(gitDir, ref);
  if (!start) return [];
  const list = await gitOk([
    "--git-dir",
    gitDir,
    "rev-list",
    "--first-parent",
    `--max-count=${limit}`,
    `--skip=${offset}`,
    start
  ]);
  const hashes = list.toString().split("\n").filter(Boolean);
  const objects = await readObjects(gitDir, hashes);
  return objects.map((o, i) => parseCommit(hashes[i], o.data));
}
async function countObjects(gitDir) {
  const out = await gitOk(["--git-dir", gitDir, "count-objects", "-v"]);
  const get = (k) => Number(new RegExp(`^${k}: (\\d+)$`, "m").exec(out.toString())?.[1] ?? 0);
  return get("count") + get("in-pack");
}

// src/binding-rpc.ts
function info(store, m) {
  return { ...listEntry(m), remote: store.remoteUrl(m.namespace, m.name) };
}
function listEntry(m) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    defaultBranch: m.defaultBranch,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastPushAt: m.lastPushAt,
    source: m.source,
    readOnly: m.readOnly,
    status: m.status
  };
}
function created(store, m, token) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    defaultBranch: m.defaultBranch,
    remote: store.remoteUrl(m.namespace, m.name),
    token
  };
}
var asOpts = (v) => v && typeof v === "object" ? v : {};
var str = (v) => typeof v === "string" ? v : void 0;
var bool = (v) => typeof v === "boolean" ? v : void 0;
var num = (v) => typeof v === "number" ? v : void 0;
async function namespaceCall(store, ns, method, args) {
  switch (method) {
    case "create": {
      const o = asOpts(args[1]);
      const r = await store.createRepo(ns, args[0], {
        readOnly: bool(o.readOnly),
        description: str(o.description),
        defaultBranch: str(o.setDefaultBranch)
      });
      return created(store, r.meta, r.token);
    }
    case "get": {
      await store.getReadyRepo(ns, args[0]);
      return null;
    }
    case "list": {
      const o = asOpts(args[0]);
      const page = await store.listRepos(ns, { limit: num(o.limit), cursor: str(o.cursor) });
      const out = { repos: page.repos.map(listEntry), total: page.total };
      if (page.nextCursor) out.cursor = page.nextCursor;
      return out;
    }
    case "import": {
      const p = asOpts(args[0]);
      const source = asOpts(p.source);
      const target = asOpts(p.target);
      const topts = asOpts(target.opts);
      const r = await store.importRepo(ns, target.name, {
        url: source.url,
        branch: str(source.branch),
        depth: num(source.depth),
        description: str(topts.description),
        readOnly: bool(topts.readOnly)
      });
      return created(store, r.meta, r.token);
    }
    case "delete":
      return await store.deleteRepo(ns, args[0]) !== null;
  }
  throw new ArtifactsError("INVALID_INPUT", `Unknown binding method: ${method}`);
}
async function repoCall(store, ns, repo, method, args) {
  const meta = await store.getReadyRepo(ns, repo);
  const gitDir = store.gitDir(ns, repo);
  const ok = (result) => ({ ok: true, result });
  const blob = (data, type) => ({
    ok: true,
    blob: data ? { base64: data.toString("base64"), type } : null
  });
  switch (method) {
    case "info":
      return ok(info(store, meta));
    case "createToken": {
      const t = await store.createToken(ns, repo, args[0], args[1]);
      return ok({ id: t.info.id, plaintext: t.plaintext, scope: t.info.scope, expiresAt: t.info.expiresAt });
    }
    case "listTokens": {
      const tokens = await store.listTokens(ns, repo, "all");
      return ok({ tokens, total: tokens.length });
    }
    case "revokeToken":
      return ok(await store.revokeToken(ns, repo, args[0]));
    case "fork": {
      const o = asOpts(args[1]);
      const r = await store.forkRepo(ns, repo, args[0], {
        description: str(o.description),
        readOnly: bool(o.readOnly),
        defaultBranchOnly: bool(o.defaultBranchOnly)
      });
      return ok(created(store, r.meta, r.token));
    }
    case "log": {
      const o = asOpts(args[0]);
      return ok(await log(gitDir, { ref: str(o.ref), limit: num(o.limit), offset: num(o.offset) }));
    }
    case "readCommit":
      return ok(await readCommit(gitDir, args[0]));
    case "readTree":
      return ok(await readTree(gitDir, args[0]));
    case "readBlob":
      return blob(await readBlob(gitDir, args[0]), "");
    case "readFile": {
      const o = asOpts(args[0]);
      const ref = str(o.ref) ?? "";
      const path = str(o.path) ?? "";
      const data = await readFileAt(gitDir, ref, path);
      return blob(data, data ? sniffContentType(data) : "");
    }
  }
  throw new ArtifactsError("INVALID_INPUT", `Unknown repository method: ${method}`);
}
async function dispatch(store, ns, req) {
  try {
    assertNamespaceName(ns);
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.repo !== void 0) return await repoCall(store, ns, req.repo, req.method, args);
    return { ok: true, result: await namespaceCall(store, ns, req.method, args) };
  } catch (e) {
    const err = e instanceof ArtifactsError ? e : new ArtifactsError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
    return { ok: false, error: { code: err.code, numericCode: err.numericCode, message: err.message } };
  }
}
var ROUTE = /^\/__local\/binding\/([^/]+)$/;
async function handleBinding(store, req, res, url) {
  const m = ROUTE.exec(url.pathname);
  if (!m || req.method !== "POST") return false;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    body = { method: "" };
  }
  const out = await dispatch(store, decodeURIComponent(m[1]), body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out));
  return true;
}

// src/events.ts
var ACCOUNT_LEVEL = /* @__PURE__ */ new Set([
  "cf.artifacts.repo.created",
  "cf.artifacts.repo.deleted",
  "cf.artifacts.repo.forked",
  "cf.artifacts.repo.imported"
]);
var EventBus = class {
  accountId;
  history = [];
  maxHistory;
  listeners = /* @__PURE__ */ new Set();
  now;
  constructor(accountId, now = Date.now, maxHistory = 1e3) {
    this.accountId = accountId;
    this.now = now;
    this.maxHistory = maxHistory;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(type, namespace, repoName, payload) {
    const event = {
      type,
      source: { type: ACCOUNT_LEVEL.has(type) ? "artifacts" : "artifacts.repo", namespace, repoName },
      payload,
      metadata: {
        accountId: this.accountId,
        eventSubscriptionId: "local",
        eventSchemaVersion: 1,
        eventTimestamp: new Date(this.now()).toISOString()
      }
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const l of this.listeners) {
      Promise.resolve().then(() => l(event)).catch(() => {
      });
    }
    return event;
  }
};
function webhookListener(url, fetchImpl = fetch) {
  return async (event) => {
    await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
  };
}

// src/store.ts
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/tokens.ts
import { createHash, randomBytes } from "node:crypto";
var DEFAULT_TTL = 86400;
var MIN_TTL = 60;
var MAX_TTL = 31536e3;
var ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
function newId() {
  const bytes = randomBytes(16);
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % 36];
  return id;
}
function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}
function resolveScope(scope) {
  if (scope === void 0 || scope === null) return "write";
  if (scope === "read" || scope === "write") return scope;
  throw new ArtifactsError("INVALID_INPUT", `Invalid option: expected one of "read"|"write"`, "/scope");
}
function resolveTtl(ttl) {
  if (ttl === void 0 || ttl === null) return DEFAULT_TTL;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) {
    throw new ArtifactsError("INVALID_TTL", `ttl must be between ${MIN_TTL} and ${MAX_TTL} seconds`, "/ttl");
  }
  return ttl;
}
function issueToken(scope, ttl, now) {
  const s = resolveScope(scope);
  const t = resolveTtl(ttl);
  const secret = `art_v2_x_${randomBytes(20).toString("hex")}`;
  const expiresSec = Math.floor(now / 1e3) + t;
  const record = {
    id: newId(),
    scope: s,
    secretHash: hashSecret(secret),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresSec * 1e3).toISOString(),
    revokedAt: null
  };
  return { record, plaintext: `${secret}?expires=${expiresSec}` };
}
function parseSecret(token) {
  const secret = token.split("?expires=")[0] ?? "";
  return /^art_(?:v1|v2_x)_[0-9a-f]{40}$/.test(secret) ? secret : null;
}
function tokenState(record, now) {
  if (record.revokedAt) return "revoked";
  if (Date.parse(record.expiresAt) <= now) return "expired";
  return "active";
}
function toTokenInfo(record, now) {
  return {
    id: record.id,
    scope: record.scope,
    state: tokenState(record, now),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}
function scopeAllows(granted, needed) {
  return granted === "write" || needed === "read";
}

// src/store.ts
var HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
var MAX_BLOB_BYTES = 32 * 1024 * 1024;
var SORT_FIELDS = {
  created_at: "createdAt",
  updated_at: "updatedAt",
  last_push_at: "lastPushAt",
  name: "name"
};
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
  }
  throw new ArtifactsError("INVALID_INPUT", "Invalid cursor");
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var Store = class {
  dataDir;
  events;
  now;
  asyncDelayMs;
  allowInsecureImport;
  maxBlobBytes;
  trackPushTimes;
  /** Base for `remote` URLs, e.g. http://127.0.0.1:8788. Set by the server once it listens. */
  publicUrl = "http://127.0.0.1:8788";
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
    this.events = opts.events ?? new EventBus(opts.accountId ?? "local", this.now);
    this.asyncDelayMs = opts.asyncDelayMs ?? 0;
    this.allowInsecureImport = opts.allowInsecureImport ?? false;
    this.maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.trackPushTimes = opts.trackPushTimes ?? false;
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  // ── paths ──
  namespaceDir(ns) {
    return join(this.dataDir, assertNamespaceName(ns));
  }
  gitDir(ns, repo) {
    return join(this.namespaceDir(ns), "repos", `${assertRepoName(repo)}.git`);
  }
  metaPath(ns, repo) {
    return join(this.gitDir(ns, repo), "artifacts-meta.json");
  }
  tokensPath(ns, repo) {
    return join(this.gitDir(ns, repo), "artifacts-tokens.json");
  }
  remoteUrl(ns, repo) {
    return `${this.publicUrl}/git/${ns}/${repo}.git`;
  }
  // ── namespaces ──
  async createNamespace(name, jurisdiction) {
    const ns = assertNamespaceName(name);
    if (jurisdiction !== void 0 && jurisdiction !== null && jurisdiction !== "eu" && jurisdiction !== "us") {
      throw new ArtifactsError("INVALID_INPUT", 'Invalid option: expected one of "eu"|"us"', "/jurisdiction");
    }
    await mkdir(this.dataDir, { recursive: true });
    try {
      await mkdir(this.namespaceDir(ns));
    } catch (e) {
      if (e.code === "EEXIST") {
        throw new ArtifactsError("ALREADY_EXISTS", "Namespace already exists");
      }
      throw e;
    }
    const at = this.iso();
    const meta = { name: ns, jurisdiction: jurisdiction ?? null, createdAt: at, updatedAt: at };
    await writeJson(join(this.namespaceDir(ns), "namespace.json"), meta);
    return meta;
  }
  /** Repo creation auto-creates its namespace, as the docs describe. */
  async ensureNamespace(ns) {
    if (await exists(join(this.namespaceDir(ns), "namespace.json"))) return;
    try {
      await this.createNamespace(ns);
    } catch (e) {
      if (!(e instanceof ArtifactsError && e.code === "ALREADY_EXISTS")) throw e;
    }
  }
  async getNamespace(name) {
    const ns = assertNamespaceName(name);
    const meta = await readJson(join(this.namespaceDir(ns), "namespace.json"));
    if (!meta) throw new ArtifactsError("NOT_FOUND", "Namespace not found");
    return meta;
  }
  async listNamespaces(opts = {}) {
    const limit = opts.limit ?? 50;
    const offset = decodeCursor(opts.cursor);
    let names = [];
    try {
      names = (await readdir(this.dataDir)).sort();
    } catch {
    }
    const all = [];
    for (const n of names) {
      const meta = await readJson(join(this.dataDir, n, "namespace.json"));
      if (meta) all.push(meta);
    }
    const items = all.slice(offset, offset + limit);
    return { items, total: all.length, nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : void 0 };
  }
  /** Number of repos in a namespace (REST `repo_count`). */
  async countRepos(name) {
    const ns = assertNamespaceName(name);
    try {
      return (await readdir(join(this.namespaceDir(ns), "repos"))).filter((e) => e.endsWith(".git")).length;
    } catch {
      return 0;
    }
  }
  async deleteNamespace(name) {
    const ns = assertNamespaceName(name);
    await this.getNamespace(ns);
    await rm(this.namespaceDir(ns), { recursive: true, force: true });
  }
  // ── repo metadata ──
  async readMeta(ns, repo) {
    return readJson(this.metaPath(ns, repo));
  }
  async writeMeta(meta) {
    await writeJson(this.metaPath(meta.namespace, meta.name), meta);
  }
  /** Metadata of a repo that exists and is ready; throws NOT_FOUND / *_IN_PROGRESS otherwise. */
  async getReadyRepo(ns, repo) {
    assertNamespaceName(ns);
    assertRepoName(repo);
    const meta = await this.readMeta(ns, repo);
    if (!meta) throw new ArtifactsError("NOT_FOUND", "Repository not found");
    if (meta.status === "forking") throw new ArtifactsError("FORK_IN_PROGRESS", `Repository ${repo} is still being forked`);
    if (meta.status === "importing") throw new ArtifactsError("IMPORT_IN_PROGRESS", `Repository ${repo} is still being imported`);
    return meta;
  }
  /** Reserve a repo directory atomically: concurrent creates of one name yield one ALREADY_EXISTS. */
  async reserve(ns, repo) {
    assertRepoName(repo);
    await this.ensureNamespace(ns);
    await mkdir(join(this.namespaceDir(ns), "repos"), { recursive: true });
    const dir = this.gitDir(ns, repo);
    try {
      await mkdir(dir);
    } catch (e) {
      if (e.code === "EEXIST") {
        throw new ArtifactsError("ALREADY_EXISTS", `repo already exists: ${repo}`);
      }
      throw e;
    }
    return dir;
  }
  newMeta(ns, repo, fields) {
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
      ...fields
    };
  }
  eventPayload(meta) {
    return {
      repoId: meta.id,
      defaultBranch: meta.defaultBranch,
      description: meta.description,
      readOnly: meta.readOnly,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastPushAt: meta.lastPushAt
    };
  }
  /** Initial token handed back by create, fork, and import (write scope, default TTL). */
  async initialToken(meta) {
    const { plaintext } = await this.createToken(meta.namespace, meta.name, "write", void 0);
    return plaintext;
  }
  // ── create / delete ──
  async createRepo(nsName, repoName, opts = {}) {
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
        readOnly: opts.readOnly ?? false
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
  async configureRepo(dir) {
    const set = (k, v) => gitOk(["--git-dir", dir, "config", k, v]);
    await set("http.receivepack", "true");
    await set("uploadpack.allowFilter", "false");
    await set("receive.denyDeleteCurrent", "false");
    await set("core.logAllRefUpdates", "false");
  }
  tombstonesPath(ns) {
    return join(this.namespaceDir(ns), "deleted.json");
  }
  /** ID of a repo that was deleted under this name, if any. Live REST answers 202 to a repeat delete. */
  async deletedRepoId(nsName, repoName) {
    const ns = assertNamespaceName(nsName);
    const repo = assertRepoName(repoName);
    return (await readJson(this.tombstonesPath(ns)))?.[repo] ?? null;
  }
  async deleteRepo(nsName, repoName) {
    const ns = assertNamespaceName(nsName);
    const repo = assertRepoName(repoName);
    const meta = await this.readMeta(ns, repo);
    if (!meta) return null;
    await rm(this.gitDir(ns, repo), { recursive: true, force: true });
    const tombstones = await readJson(this.tombstonesPath(ns)) ?? {};
    tombstones[repo] = meta.id;
    await writeJson(this.tombstonesPath(ns), tombstones);
    this.events.emit("cf.artifacts.repo.deleted", ns, repo, this.eventPayload(meta));
    return meta;
  }
  // ── list ──
  async listRepos(nsName, opts = {}) {
    const ns = assertNamespaceName(nsName);
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ArtifactsError(
        "INVALID_INPUT",
        limit < 1 ? "Too small: expected number to be >0" : "Too big: expected number to be <=200",
        "/limit"
      );
    }
    const sort = opts.sort ?? "created_at";
    if (!(sort in SORT_FIELDS)) {
      throw new ArtifactsError(
        "INVALID_INPUT",
        'Invalid option: expected one of "created_at"|"updated_at"|"last_push_at"|"name"',
        "/sort"
      );
    }
    const direction = opts.direction ?? "desc";
    if (direction !== "asc" && direction !== "desc") {
      throw new ArtifactsError("INVALID_INPUT", 'Invalid option: expected one of "asc"|"desc"', "/direction");
    }
    const offset = decodeCursor(opts.cursor);
    let entries = [];
    try {
      entries = await readdir(join(this.namespaceDir(ns), "repos"));
    } catch {
    }
    let all = [];
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
      nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : void 0
    };
  }
  // ── fork / import ──
  /**
   * Publish `meta` in its in-progress state, build the repo in a temp dir, then swap it in.
   * While building, get() sees FORK_IN_PROGRESS / IMPORT_IN_PROGRESS rather than NOT_FOUND.
   */
  async materialize(dir, meta, build) {
    const tmp = `${dir}.build-${newId()}`;
    try {
      await this.writeMeta(meta);
      await build(tmp);
      if (this.asyncDelayMs) await sleep(this.asyncDelayMs);
      await this.configureRepo(tmp);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      const ready = { ...meta, status: "ready", updatedAt: this.iso() };
      await this.writeMeta(ready);
      await writeJson(this.tokensPath(meta.namespace, meta.name), []);
      return ready;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async forkRepo(nsName, repoName, targetName, opts = {}) {
    const ns = assertNamespaceName(nsName);
    const src = await this.getReadyRepo(ns, assertRepoName(repoName));
    const target = assertRepoName(targetName);
    const dir = await this.reserve(ns, target);
    const srcDir = this.gitDir(ns, src.name);
    const meta = this.newMeta(ns, target, {
      // Live: a fork does not inherit the source's description.
      description: opts.description ?? null,
      defaultBranch: src.defaultBranch,
      readOnly: opts.readOnly ?? false,
      source: `artifacts:${ns}/${src.name}`,
      status: "forking"
    });
    const ready = await this.materialize(dir, meta, async (tmp) => {
      const hasCommits = (await git(["--git-dir", srcDir, "rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
      if (!hasCommits) {
        await gitOk(["init", "-q", "--bare", "-b", src.defaultBranch, tmp]);
        return;
      }
      await gitOk(["clone", "-q", "--bare", srcDir, tmp]);
      await gitOk(["--git-dir", tmp, "remote", "remove", "origin"]);
    });
    const objects = await countObjects(dir);
    this.events.emit("cf.artifacts.repo.forked", ns, src.name, {
      namespace: ns,
      repoName: target,
      ...this.eventPayload(ready)
    });
    const token = await this.initialToken(ready);
    return { meta: ready, token, objects };
  }
  async importRepo(nsName, repoName, params) {
    const ns = assertNamespaceName(nsName);
    const target = assertRepoName(repoName);
    const url = params.url;
    if (typeof url !== "string" || !url) throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
    if (!this.allowInsecureImport && !/^https:\/\//.test(url)) {
      throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
    }
    if (params.depth !== void 0 && (!Number.isInteger(params.depth) || params.depth < 1)) {
      throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/depth");
    }
    if (params.branch !== void 0 && (typeof params.branch !== "string" || !params.branch || params.branch.startsWith("-"))) {
      throw new ArtifactsError("INVALID_INPUT", "Invalid branch", "/branch");
    }
    const dir = await this.reserve(ns, target);
    const meta = this.newMeta(ns, target, {
      description: params.description ?? null,
      readOnly: params.readOnly ?? false,
      source: importSource(url),
      status: "importing"
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
    const final = { ...ready, defaultBranch: params.branch ?? "main" };
    await this.writeMeta(final);
    this.events.emit("cf.artifacts.repo.imported", ns, target, {
      ...this.eventPayload(final),
      sourceUrl: url,
      branch: head
    });
    const token = await this.initialToken(final);
    return { meta: final, token };
  }
  // ── push bookkeeping (called by the git HTTP layer) ──
  async recordPush(ns, repo) {
    const meta = await this.readMeta(ns, repo);
    if (!meta) return;
    const at = this.iso();
    await this.writeMeta({ ...meta, updatedAt: at, lastPushAt: at });
  }
  // ── tokens ──
  async readTokens(ns, repo) {
    return await readJson(this.tokensPath(ns, repo)) ?? [];
  }
  async createToken(ns, repo, scope, ttl) {
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
      expiresAt: record.expiresAt
    });
    return { info: toTokenInfo(record, this.now()), plaintext };
  }
  async listTokens(ns, repo, state = "all") {
    await this.getReadyRepo(ns, repo);
    const now = this.now();
    return (await this.readTokens(ns, repo)).map((r) => toTokenInfo(r, now)).filter((t) => state === "all" || t.state === state);
  }
  /** Revoke by token id or plaintext. Returns false when no token matches. */
  async revokeToken(ns, repo, tokenOrId) {
    if (typeof tokenOrId !== "string" || !tokenOrId) {
      throw new ArtifactsError("INVALID_INPUT", "tokenOrId must be a non-empty string");
    }
    const tokens = await this.readTokens(ns, repo);
    const secret = parseSecret(tokenOrId);
    const hash = secret ? hashSecret(secret) : null;
    const t = tokens.find((r) => r.id === tokenOrId || hash !== null && r.secretHash === hash);
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
  async revokeTokenById(nsName, id) {
    const ns = assertNamespaceName(nsName);
    let cursor;
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
  async authenticate(ns, repo, presented, needed) {
    const secret = parseSecret(presented);
    if (!secret) return "unauthorized";
    const hash = hashSecret(secret);
    const now = this.now();
    const t = (await this.readTokens(ns, repo)).find((r) => r.secretHash === hash);
    if (!t || tokenState(t, now) !== "active") return "unauthorized";
    return scopeAllows(t.scope, needed) ? "ok" : "forbidden";
  }
};
function importSource(url) {
  return `git:${url.replace(/\/+$/, "").replace(/(?<!\.git)$/, ".git")}`;
}
function importError(stderr, url = "") {
  const s = stderr.toLowerCase();
  if (/could not read username|authentication failed|terminal prompts disabled|401|403/.test(s)) {
    return new ArtifactsError(
      "REMOTE_AUTH_REQUIRED",
      `Repository "${url}" requires authentication (HTTP 401). Only public repositories can be imported.`,
      "/url"
    );
  }
  if (/could not resolve host|failed to connect|connection refused|timed out|unable to access/.test(s)) {
    return new ArtifactsError("UPSTREAM_UNAVAILABLE", "The remote git server could not be reached", "/url");
  }
  if (/not found|does not exist|404/.test(s)) {
    return new ArtifactsError(
      "INVALID_URL",
      "url must be an HTTPS git remote URL (e.g. https://github.com/owner/repo)",
      "/url"
    );
  }
  return new ArtifactsError("INVALID_URL", "url must be an HTTPS git remote URL (e.g. https://github.com/owner/repo)", "/url");
}

// src/server.ts
import { createServer } from "node:http";

// src/git-http.ts
import { spawn as spawn2 } from "node:child_process";
import { dirname as dirname2 } from "node:path";
import { gunzipSync } from "node:zlib";
var ZERO = "0".repeat(40);
var MAX_PUSH_COMMITS = 20;
var ROUTE2 = /^\/git\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/;
function parseGitRoute(method, pathname, query) {
  const m = ROUTE2.exec(pathname);
  if (!m) return null;
  const [, ns, repo, tail] = m;
  if (!isValidNamespaceName(ns) || !isValidRepoName(repo)) return null;
  let service;
  if (tail === "/info/refs") {
    if (method !== "GET") return null;
    service = query.get("service");
  } else {
    if (method !== "POST") return null;
    service = tail.slice(1);
  }
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
  return { ns, repo, service, path: tail };
}
function presentedToken(header) {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(value, "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return decoded.slice(colon + 1) || null;
  }
  return null;
}
function plain(res, status, message, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(`${message}
`);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function classifyUploadPack(body, encoding) {
  let text;
  try {
    text = (encoding === "gzip" ? gunzipSync(body) : body).toString("latin1");
  } catch {
    return "none";
  }
  if (!/want [0-9a-f]{40}/.test(text)) return "none";
  return /have [0-9a-f]{40}/.test(text) ? "fetch" : "clone";
}
var PackDetector = class {
  found = false;
  tail = Buffer.alloc(0);
  push(chunk) {
    if (this.found) return;
    const joined = Buffer.concat([this.tail, chunk]);
    if (joined.includes("PACK", 0, "latin1")) this.found = true;
    this.tail = joined.subarray(Math.max(0, joined.length - 4));
  }
};
async function refSnapshot(gitDir) {
  const r = await git(["--git-dir", gitDir, "for-each-ref", "--format=%(objectname) %(refname)"]);
  const map = /* @__PURE__ */ new Map();
  for (const line of r.stdout.toString().split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    map.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return map;
}
async function pushPayloads(gitDir, before, after) {
  const refs = /* @__PURE__ */ new Set([...before.keys(), ...after.keys()]);
  const payloads = [];
  for (const ref of [...refs].sort()) {
    const b = before.get(ref) ?? ZERO;
    const a = after.get(ref) ?? ZERO;
    if (a === b) continue;
    let hashes = [];
    if (a !== ZERO) {
      const exclude = [...new Set(before.values())].map((h) => `^${h}`);
      const r = await git(["--git-dir", gitDir, "rev-list", a, ...exclude]);
      hashes = r.stdout.toString().split("\n").filter(Boolean);
    }
    const shown = hashes.slice(0, MAX_PUSH_COMMITS);
    const objects = await readObjects(gitDir, shown);
    payloads.push({
      ref,
      before: b,
      after: a,
      commits: objects.flatMap((o, i) => {
        if (!o || o.type !== "commit") return [];
        const c = parseCommit(shown[i], o.data);
        return [{
          id: c.hash,
          message: c.message,
          messageTruncated: false,
          timestamp: new Date(c.committedAt * 1e3).toISOString(),
          author: c.author,
          committer: c.committer,
          parents: c.parents
        }];
      }),
      totalCommitsCount: hashes.length,
      commitsTruncated: hashes.length > shown.length
    });
  }
  return payloads;
}
var pushLocks = /* @__PURE__ */ new Map();
function withLock(key, fn) {
  const prev = pushLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  pushLocks.set(key, next.catch(() => {
  }));
  return next;
}
function runBackend(store, route2, req, res, query, opts = {}) {
  const gitDir = store.gitDir(route2.ns, route2.repo);
  const env = {
    ...process.env,
    ...ISOLATED_GIT_ENV,
    GIT_PROJECT_ROOT: dirname2(gitDir),
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${route2.repo}.git${route2.path}`,
    REQUEST_METHOD: req.method ?? "GET",
    QUERY_STRING: query,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_USER: "artifacts",
    REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
    ARTIFACTS_MAX_BLOB_BYTES: String(store.maxBlobBytes)
  };
  if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
  const config = [["core.hooksPath", HOOKS_DIR]];
  const proto = req.headers["git-protocol"];
  if (route2.service === "git-upload-pack" && typeof proto === "string") {
    env.GIT_PROTOCOL = proto;
    if (/version=2/.test(proto)) config.push(["uploadpack.allowFilter", "true"]);
  }
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolve, reject) => {
    const child = spawn2("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let headerBuf = Buffer.alloc(0);
    let headersSent = false;
    let status = 200;
    child.stdout.on("data", (chunk) => {
      if (headersSent) {
        opts.tap?.(chunk);
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      let end = headerBuf.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (end === -1) {
        end = headerBuf.indexOf("\n\n");
        sepLen = 2;
      }
      if (end === -1) return;
      const headers = {};
      for (const line of headerBuf.subarray(0, end).toString().split(/\r?\n/)) {
        const colon = line.indexOf(":");
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k.toLowerCase() === "status") status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      headersSent = true;
      const rest = headerBuf.subarray(end + sepLen);
      if (rest.length) {
        opts.tap?.(rest);
        res.write(rest);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!headersSent) plain(res, 500, "git http-backend failed");
      else if (!opts.keepOpen) res.end();
      resolve(code === 0 ? status : 500);
    });
    child.stdin.on("error", () => {
    });
    if (opts.body) child.stdin.end(opts.body);
    else req.pipe(child.stdin);
  });
}
async function handleGit(store, req, res, url) {
  const route2 = parseGitRoute(req.method ?? "GET", url.pathname, url.searchParams);
  if (!route2) {
    if (url.pathname.startsWith("/git/")) {
      plain(res, 404, "Not found");
      return true;
    }
    return false;
  }
  try {
    await store.getReadyRepo(route2.ns, route2.repo);
  } catch (e) {
    const err = e;
    plain(res, err.status ?? 500, err.message);
    return true;
  }
  const needed = route2.service === "git-receive-pack" ? "write" : "read";
  const token = presentedToken(req.headers.authorization);
  if (!token) {
    plain(res, 401, "Authentication required", { "www-authenticate": 'Basic realm="Artifacts"' });
    return true;
  }
  const auth = await store.authenticate(route2.ns, route2.repo, token, needed);
  if (auth === "unauthorized") {
    plain(res, 403, "Invalid or expired token");
    return true;
  }
  if (auth === "forbidden") {
    plain(res, 403, "Insufficient permissions");
    return true;
  }
  const query = url.search.slice(1);
  if (route2.service === "git-upload-pack") {
    if (route2.path === "/info/refs") {
      await runBackend(store, route2, req, res, query);
      return true;
    }
    const body = await readBody(req);
    const kind = classifyUploadPack(body, req.headers["content-encoding"]);
    const pack = new PackDetector();
    const status = await runBackend(store, route2, req, res, query, { body, tap: (c) => pack.push(c) });
    if (status === 200 && kind !== "none" && pack.found) {
      store.events.emit(kind === "clone" ? "cf.artifacts.repo.cloned" : "cf.artifacts.repo.fetched", route2.ns, route2.repo, {});
    }
    return true;
  }
  if (route2.path === "/info/refs") {
    await runBackend(store, route2, req, res, query);
    return true;
  }
  const gitDir = store.gitDir(route2.ns, route2.repo);
  await withLock(gitDir, async () => {
    const before = await refSnapshot(gitDir);
    try {
      await runBackend(store, route2, req, res, query, { keepOpen: true });
      const after = await refSnapshot(gitDir);
      const payloads = await pushPayloads(gitDir, before, after);
      if (payloads.length) {
        if (store.trackPushTimes) await store.recordPush(route2.ns, route2.repo);
        for (const p of payloads) store.events.emit("cf.artifacts.repo.pushed", route2.ns, route2.repo, p);
      }
    } finally {
      res.end();
    }
  });
  return true;
}

// src/rest.ts
var REST_PREFIX = /^\/client\/v4\/accounts\/([^/]+)\/artifacts(\/.*)?$/;
function send(res, reply) {
  if (reply.empty) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  if (reply.bytes) {
    res.writeHead(reply.status, { "content-type": reply.bytes.type, "content-length": reply.bytes.data.length });
    res.end(reply.bytes.data);
    return;
  }
  const body = { result: reply.result ?? null, success: true, errors: [], messages: [] };
  if (reply.resultInfo) body.result_info = reply.resultInfo;
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function sendError(res, status, errors) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: null, success: false, errors, messages: [] }));
}
function repoInfo(store, m) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    default_branch: m.defaultBranch,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    last_push_at: m.lastPushAt,
    source: m.source,
    read_only: m.readOnly,
    remote: store.remoteUrl(m.namespace, m.name)
  };
}
function listInfo(nextCursor, perPage, count, total) {
  if (nextCursor) return { cursor: nextCursor, per_page: perPage, count };
  return { page: 1, per_page: perPage, total_pages: Math.ceil(total / perPage), count, total_count: total };
}
function created2(store, m, token) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    default_branch: m.defaultBranch,
    remote: store.remoteUrl(m.namespace, m.name),
    token
  };
}
async function namespaceInfo(store, n) {
  return {
    namespace: n.name,
    jurisdiction: n.jurisdiction ?? "unrestricted",
    repo_count: await store.countRepos(n.name),
    created_at: n.createdAt,
    updated_at: n.updatedAt ?? n.createdAt
  };
}
function tokenInfo(t) {
  return { id: t.id, scope: t.scope, state: t.state, created_at: t.createdAt, expires_at: t.expiresAt };
}
function treeInfo(e) {
  return { name: e.name, mode: e.mode, hash: e.hash, type: e.type };
}
async function jsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactsError("INVALID_INPUT", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactsError("INVALID_INPUT", "Request body must be a JSON object");
  }
  return parsed;
}
function intParam(q, name) {
  const v = q.get(name);
  if (v === null || v === "") return void 0;
  if (!/^-?\d+$/.test(v)) throw new ArtifactsError("INVALID_INPUT", "Invalid input: expected number, received NaN", `/${name}`);
  return Number(v);
}
function optString(body, key) {
  const v = body[key];
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "string") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected string, received ${typeof v}`, `/${key}`);
  return v;
}
function optBool(body, key) {
  const v = body[key];
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "boolean") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected boolean, received ${typeof v}`, `/${key}`);
  return v;
}
function optNumber(body, key) {
  const v = body[key];
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "number") throw new ArtifactsError("INVALID_INPUT", `Invalid input: expected number, received ${typeof v}`, `/${key}`);
  return v;
}
function notFound(message) {
  throw new ArtifactsError("NOT_FOUND", message);
}
var TOKEN_STATES = /* @__PURE__ */ new Set(["active", "expired", "revoked", "all"]);
async function route(store, req, sub, q) {
  const method = req.method ?? "GET";
  const parts = sub.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "namespaces") return noRoute();
  if (parts.length === 1) {
    if (method === "POST") {
      const body = await jsonBody(req);
      const ns2 = await store.createNamespace(body.namespace, body.jurisdiction);
      return { status: 201, result: await namespaceInfo(store, ns2) };
    }
    if (method === "GET") {
      const limit = intParam(q, "limit") ?? 50;
      const page = await store.listNamespaces({ limit, cursor: q.get("cursor") ?? void 0 });
      return {
        status: 200,
        result: await Promise.all(page.items.map((n) => namespaceInfo(store, n))),
        resultInfo: listInfo(page.nextCursor, limit, page.items.length, page.total)
      };
    }
    return noRoute();
  }
  const ns = parts[1];
  if (parts.length === 2) {
    if (method === "GET") return { status: 200, result: await namespaceInfo(store, await store.getNamespace(ns)) };
    if (method === "DELETE") {
      await store.deleteNamespace(ns);
      return { status: 204, empty: true };
    }
    return noRoute();
  }
  if (parts[2] === "tokens") {
    if (parts.length === 3 && method === "POST") {
      const body = await jsonBody(req);
      const repo = body.repo;
      if (typeof repo !== "string" || !repo) throw new ArtifactsError("INVALID_INPUT", "repo required", "/repo");
      const t = await store.createToken(ns, repo, body.scope, body.ttl);
      return {
        status: 201,
        result: { id: t.info.id, plaintext: t.plaintext, scope: t.info.scope, expires_at: t.info.expiresAt }
      };
    }
    if (parts.length === 4 && method === "DELETE") {
      const id = parts[3];
      if (await store.revokeTokenById(ns, id) === "missing") notFound("Token not found");
      return { status: 200, result: { id } };
    }
    return noRoute();
  }
  if (parts[2] !== "repos") return noRoute();
  if (parts.length === 3) {
    if (method === "POST") {
      const body = await jsonBody(req);
      const r = await store.createRepo(ns, body.name, {
        description: optString(body, "description"),
        defaultBranch: optString(body, "default_branch"),
        readOnly: optBool(body, "read_only")
      });
      return { status: 201, result: created2(store, r.meta, r.token) };
    }
    if (method === "GET") {
      const limit = intParam(q, "limit") ?? 50;
      const page = await store.listRepos(ns, {
        limit,
        cursor: q.get("cursor") ?? void 0,
        search: q.get("search") ?? void 0,
        sort: q.get("sort") ?? void 0,
        direction: q.get("direction") ?? void 0
      });
      return {
        status: 200,
        // REST list entries carry `status`, unlike a single-repo GET.
        result: page.repos.map((m) => ({ ...repoInfo(store, m), status: m.status })),
        resultInfo: listInfo(page.nextCursor, limit, page.repos.length, page.total)
      };
    }
    return noRoute();
  }
  const name = parts[3];
  const action = parts[4];
  if (parts.length === 4) {
    if (method === "GET") return { status: 200, result: repoInfo(store, await store.getReadyRepo(ns, name)) };
    if (method === "DELETE") {
      const meta = await store.deleteRepo(ns, name);
      const id = meta?.id ?? await store.deletedRepoId(ns, name) ?? notFound("Repository not found");
      return { status: 202, result: { id } };
    }
    return noRoute();
  }
  if (action === "import" && parts.length === 5 && method === "POST") {
    const body = await jsonBody(req);
    const r = await store.importRepo(ns, name, {
      url: body.url,
      branch: optString(body, "branch"),
      depth: optNumber(body, "depth"),
      readOnly: optBool(body, "read_only")
    });
    return { status: 201, result: created2(store, r.meta, r.token) };
  }
  if (action === "fork" && parts.length === 5 && method === "POST") {
    const body = await jsonBody(req);
    const r = await store.forkRepo(ns, name, body.name, {
      description: optString(body, "description"),
      readOnly: optBool(body, "read_only"),
      defaultBranchOnly: optBool(body, "default_branch_only")
    });
    return { status: 201, result: { ...created2(store, r.meta, r.token), objects: r.objects } };
  }
  if (method !== "GET") return noRoute();
  await store.getReadyRepo(ns, name);
  const gitDir = store.gitDir(ns, name);
  switch (action) {
    case "log": {
      if (parts.length !== 5) return noRoute();
      const commits = await log(gitDir, {
        ref: q.get("ref") || void 0,
        limit: intParam(q, "limit"),
        offset: intParam(q, "offset")
      });
      return { status: 200, result: commits };
    }
    case "commit": {
      if (parts.length !== 6) return noRoute();
      const c = await readCommit(gitDir, parts[5]) ?? notFound("Commit not found");
      return { status: 200, result: c };
    }
    case "tree": {
      if (parts.length !== 6) return noRoute();
      const t = await readTree(gitDir, parts[5]) ?? notFound("Tree not found");
      return { status: 200, result: t.map(treeInfo) };
    }
    case "blob": {
      if (parts.length !== 6) return noRoute();
      const b = await readBlob(gitDir, parts[5]) ?? notFound("Blob not found");
      return { status: 200, bytes: { data: b, type: "application/octet-stream" } };
    }
    case "file": {
      if (parts.length !== 5) return noRoute();
      const ref = q.get("ref") ?? "";
      const path = q.get("path") ?? "";
      const f = await readFileAt(gitDir, ref, path) ?? notFound("File not found");
      return { status: 200, bytes: { data: f, type: "application/octet-stream" } };
    }
    case "raw": {
      const [ref, ...rest] = parts.slice(5);
      if (!ref || rest.length === 0) notFound("File not found");
      const f = await readFileAt(gitDir, ref, rest.join("/")) ?? notFound("File not found");
      return { status: 200, bytes: { data: f, type: sniffContentType(f).replace(";charset", "; charset") } };
    }
    case "tokens": {
      if (parts.length !== 5) return noRoute();
      const state = q.get("state") ?? "active";
      if (!TOKEN_STATES.has(state)) throw new ArtifactsError("INVALID_INPUT", `Invalid state: ${state}`);
      const perPage = intParam(q, "per_page") ?? 30;
      const page = intParam(q, "page") ?? 1;
      if (perPage < 1 || perPage > 100) throw new ArtifactsError("INVALID_INPUT", "per_page must be between 1 and 100");
      if (page < 1) throw new ArtifactsError("INVALID_INPUT", "page must be at least 1");
      const all = await store.listTokens(ns, name, state);
      const items = all.slice((page - 1) * perPage, page * perPage);
      return {
        status: 200,
        result: items.map(tokenInfo),
        resultInfo: {
          page,
          per_page: perPage,
          total_pages: Math.max(1, Math.ceil(all.length / perPage)),
          count: items.length,
          total_count: all.length
        }
      };
    }
  }
  return noRoute();
}
var NoRoute = class extends Error {
};
function noRoute() {
  throw new NoRoute();
}
async function handleRest(store, req, res, url, opts = {}) {
  const m = REST_PREFIX.exec(url.pathname);
  if (!m) return false;
  const auth = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
  if (!bearer || opts.apiToken !== void 0 && bearer !== opts.apiToken) {
    sendError(res, 401, [{ code: 1e4, message: "Authentication error" }]);
    return true;
  }
  if (opts.accountId !== void 0 && m[1] !== opts.accountId) {
    sendError(res, 403, [{ code: 1e4, message: "Authentication error" }]);
    return true;
  }
  try {
    send(res, await route(store, req, m[2] ?? "", url.searchParams));
  } catch (e) {
    if (e instanceof NoRoute) {
      res.writeHead(404, { "content-type": "text/plain; charset=UTF-8" });
      res.end("404 Not Found");
    } else if (e instanceof ArtifactsError) {
      sendError(res, e.status, [e.toApiError()]);
    } else {
      sendError(res, 500, [{ code: 10400, message: e instanceof Error ? e.message : "Internal error" }]);
    }
  }
  return true;
}

// src/server.ts
async function handleLocal(store, req, res, url) {
  if (!url.pathname.startsWith("/__local/")) return false;
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/__local/health") {
    json(200, { ok: true });
    return true;
  }
  if (url.pathname === "/__local/events") {
    if (req.method === "DELETE") {
      store.events.history.length = 0;
      json(200, { ok: true });
      return true;
    }
    const type = url.searchParams.get("type");
    json(200, store.events.history.filter((e) => !type || e.type === type));
    return true;
  }
  return false;
}
async function startServer(opts, extra = []) {
  const now = opts.now ?? Date.now;
  const events = new EventBus(opts.accountId ?? "local", now);
  if (opts.webhookUrl) events.subscribe(webhookListener(opts.webhookUrl));
  const store = new Store({
    dataDir: opts.dataDir,
    accountId: opts.accountId,
    events,
    now,
    asyncDelayMs: opts.asyncDelayMs,
    allowInsecureImport: opts.allowInsecureImport,
    maxBlobBytes: opts.maxBlobBytes,
    trackPushTimes: opts.trackPushTimes
  });
  const handlers = [
    handleLocal,
    (s, req, res, url2) => handleRest(s, req, res, url2, opts),
    handleGit,
    ...extra
  ];
  const server = createServer(async (req, res) => {
    const url2 = new URL(req.url ?? "/", "http://localhost");
    try {
      for (const h of handlers) {
        if (await h(store, req, res, url2)) return;
      }
      sendError(res, 404, [{ code: 7e3, message: "No route for that URI" }]);
    } catch (e) {
      if (!res.headersSent) sendError(res, 500, [{ code: 10400, message: e instanceof Error ? e.message : "Internal error" }]);
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  store.publicUrl = opts.publicUrl ?? url;
  return {
    url,
    store,
    server,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

export {
  handleBinding,
  EventBus,
  webhookListener,
  Store,
  startServer
};
