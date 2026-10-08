import { t as ArtifactsError } from "./errors-FRdRD_TM.js";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
//#region src/names.ts
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidNamespaceName(name) {
	return typeof name === "string" && name.length >= 2 && name.length <= 63 && NAME.test(name);
}
function isValidRepoName(name) {
	return typeof name === "string" && name.length >= 1 && name.length <= 63 && NAME.test(name);
}
function assertNamespaceName(name) {
	if (!isValidNamespaceName(name)) throw new ArtifactsError("INVALID_INPUT", "Invalid namespace name", "/namespace");
	return name;
}
function assertRepoName(name) {
	if (!isValidRepoName(name)) throw new ArtifactsError("INVALID_REPO_NAME", "Invalid repo name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/", "/name");
	return name;
}
const HASH = /^[0-9a-f]{40}$/;
function assertHash(hash) {
	if (typeof hash !== "string" || !HASH.test(hash)) throw new ArtifactsError("INVALID_INPUT", "Invalid SHA-1 hash", "/hash");
	return hash;
}
//#endregion
//#region src/git.ts
/** Keep the user's global/system git config (hooks, signing, aliases) out of the emulator. */
const ISOLATED_GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: "C"
};
function git(args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd: opts.cwd,
			env: {
				...process.env,
				...ISOLATED_GIT_ENV,
				...opts.env
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		const out = [];
		const err = [];
		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code: code ?? 1,
				stdout: Buffer.concat(out),
				stderr: Buffer.concat(err).toString()
			});
		});
		child.stdin.on("error", () => {});
		if (opts.input !== void 0) child.stdin.end(opts.input);
		else child.stdin.end();
	});
}
/** Run git and throw INTERNAL_ERROR on a non-zero exit. */
async function gitOk(args, opts = {}) {
	const r = await git(args, opts);
	if (r.code !== 0) throw new ArtifactsError("INTERNAL_ERROR", `git ${args[0]} failed: ${r.stderr.trim()}`);
	return r.stdout;
}
/** Read many objects in one `git cat-file --batch`. Missing objects map to null. */
async function readObjects(gitDir, hashes) {
	if (hashes.length === 0) return [];
	const out = await gitOk([
		"--git-dir",
		gitDir,
		"cat-file",
		"--batch"
	], { input: `${hashes.join("\n")}\n` });
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
		results.push({
			hash,
			type,
			data: out.subarray(pos, pos + len)
		});
		pos += len + 1;
	}
	return results;
}
async function readObject(gitDir, hash) {
	const [obj] = await readObjects(gitDir, [hash]);
	return obj ?? null;
}
function assertRef(ref) {
	if (ref.startsWith("-") || ref.includes("\0")) throw new ArtifactsError("INVALID_INPUT", `Invalid ref: ${JSON.stringify(ref)}`);
}
/** Resolve a branch, tag, or commit ID to a commit hash; null if it does not resolve. */
async function resolveCommit(gitDir, ref) {
	assertRef(ref);
	const r = await git([
		"--git-dir",
		gitDir,
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${ref}^{commit}`
	]);
	return r.code === 0 ? r.stdout.toString().trim() : null;
}
function parseIdentity(value) {
	const m = /^(.*?) <([^>]*)> (-?\d+) [+-]\d{4}$/.exec(value);
	if (!m) return {
		who: {
			name: value,
			email: ""
		},
		at: 0
	};
	return {
		who: {
			name: m[1],
			email: m[2]
		},
		at: Number(m[3])
	};
}
function parseCommit(hash, data) {
	const text = data.toString("utf8");
	const split = text.indexOf("\n\n");
	const head = split === -1 ? text : text.slice(0, split);
	let message = split === -1 ? "" : text.slice(split + 2);
	if (message.endsWith("\n")) message = message.slice(0, -1);
	let treeHash = "";
	const parents = [];
	let author = {
		who: {
			name: "",
			email: ""
		},
		at: 0
	};
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
const MODE_TYPES = {
	"40000": "tree",
	"100644": "blob",
	"100755": "exec",
	"120000": "symlink",
	"160000": "gitlink"
};
/** Parse the binary tree format: `<mode> <name>\0<20-byte id>` repeated. */
function parseTree(data) {
	const entries = [];
	let pos = 0;
	while (pos < data.length) {
		const sp = data.indexOf(32, pos);
		const nul = data.indexOf(0, sp);
		const mode = data.subarray(pos, sp).toString();
		const name = data.subarray(sp + 1, nul).toString("utf8");
		const hash = data.subarray(nul + 1, nul + 21).toString("hex");
		entries.push({
			name,
			mode,
			hash,
			type: MODE_TYPES[mode] ?? "blob"
		});
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
/** Resolve `path` at `ref` to blob bytes; null for a missing ref, missing path, or a directory. */
async function readFileAt(gitDir, ref, path) {
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
		`${commit}:${clean}`
	]);
	if (r.code !== 0) return null;
	return readBlob(gitDir, r.stdout.toString().trim());
}
/** The two types the docs list as tested: UTF-8 text, or opaque binary. */
function sniffContentType(data) {
	if (data.includes(0)) return "application/octet-stream";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(data);
		return "text/plain;charset=utf-8";
	} catch {
		return "application/octet-stream";
	}
}
const LOG_MAX_LIMIT = 1e3;
async function log(gitDir, opts = {}) {
	const ref = opts.ref ?? "HEAD";
	const limit = Math.min(opts.limit ?? 50, LOG_MAX_LIMIT);
	const offset = opts.offset ?? 0;
	if (!Number.isInteger(limit) || limit < 1) throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/limit");
	if (!Number.isInteger(offset) || offset < 0) throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >=0", "/offset");
	const start = await resolveCommit(gitDir, ref);
	if (!start) return [];
	const hashes = (await gitOk([
		"--git-dir",
		gitDir,
		"rev-list",
		"--first-parent",
		`--max-count=${limit}`,
		`--skip=${offset}`,
		start
	])).toString().split("\n").filter(Boolean);
	return (await readObjects(gitDir, hashes)).map((o, i) => parseCommit(hashes[i], o.data));
}
async function countObjects(gitDir) {
	const out = await gitOk([
		"--git-dir",
		gitDir,
		"count-objects",
		"-v"
	]);
	const get = (k) => Number(new RegExp(`^${k}: (\\d+)$`, "m").exec(out.toString())?.[1] ?? 0);
	return get("count") + get("in-pack");
}
//#endregion
//#region src/binding-rpc.ts
function info(store, m) {
	return {
		...listEntry(m),
		remote: store.remoteUrl(m.namespace, m.name)
	};
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
function created$1(store, m, token) {
	return {
		id: m.id,
		name: m.name,
		description: m.description,
		defaultBranch: m.defaultBranch,
		remote: store.remoteUrl(m.namespace, m.name),
		token
	};
}
const asOpts = (v) => v && typeof v === "object" ? v : {};
const str = (v) => typeof v === "string" ? v : void 0;
const bool = (v) => typeof v === "boolean" ? v : void 0;
const num = (v) => typeof v === "number" ? v : void 0;
async function namespaceCall(store, ns, method, args) {
	switch (method) {
		case "create": {
			const o = asOpts(args[1]);
			const r = await store.createRepo(ns, args[0], {
				readOnly: bool(o.readOnly),
				description: str(o.description),
				defaultBranch: str(o.setDefaultBranch)
			});
			return created$1(store, r.meta, r.token);
		}
		case "get":
			await store.getReadyRepo(ns, args[0]);
			return null;
		case "list": {
			const o = asOpts(args[0]);
			const page = await store.listRepos(ns, {
				limit: num(o.limit),
				cursor: str(o.cursor)
			});
			const out = {
				repos: page.repos.map(listEntry),
				total: page.total
			};
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
			return created$1(store, r.meta, r.token);
		}
		case "delete": return await store.deleteRepo(ns, args[0]) !== null;
	}
	throw new ArtifactsError("INVALID_INPUT", `Unknown binding method: ${method}`);
}
const ok = (result) => ({
	ok: true,
	result
});
const blob = (data, type) => ({
	ok: true,
	blob: data ? {
		base64: data.toString("base64"),
		type
	} : null
});
async function repoCall(store, ns, repo, method, args) {
	const meta = await store.getReadyRepo(ns, repo);
	const gitDir = store.gitDir(ns, repo);
	switch (method) {
		case "info": return ok(info(store, meta));
		case "createToken": {
			const t = await store.createToken(ns, repo, args[0], args[1]);
			return ok({
				id: t.info.id,
				plaintext: t.plaintext,
				scope: t.info.scope,
				expiresAt: t.info.expiresAt
			});
		}
		case "listTokens": {
			const tokens = await store.listTokens(ns, repo, "all");
			return ok({
				tokens,
				total: tokens.length
			});
		}
		case "revokeToken": return ok(await store.revokeToken(ns, repo, args[0]));
		case "fork": {
			const o = asOpts(args[1]);
			const r = await store.forkRepo(ns, repo, args[0], {
				description: str(o.description),
				readOnly: bool(o.readOnly),
				defaultBranchOnly: bool(o.defaultBranchOnly)
			});
			return ok(created$1(store, r.meta, r.token));
		}
		case "log": {
			const o = asOpts(args[0]);
			return ok(await log(gitDir, {
				ref: str(o.ref),
				limit: num(o.limit),
				offset: num(o.offset)
			}));
		}
		case "readCommit": return ok(await readCommit(gitDir, args[0]));
		case "readTree": return ok(await readTree(gitDir, args[0]));
		case "readBlob": return blob(await readBlob(gitDir, args[0]), "");
		case "readFile": {
			const o = asOpts(args[0]);
			const data = await readFileAt(gitDir, str(o.ref) ?? "", str(o.path) ?? "");
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
		return {
			ok: true,
			result: await namespaceCall(store, ns, req.method, args)
		};
	} catch (e) {
		const err = e instanceof ArtifactsError ? e : new ArtifactsError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
		return {
			ok: false,
			error: {
				code: err.code,
				numericCode: err.numericCode,
				message: err.message
			}
		};
	}
}
const ROUTE$1 = /^\/__local\/binding\/([^/]+)$/;
async function handleBinding(store, req, res, url) {
	const m = ROUTE$1.exec(url.pathname);
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
//#endregion
//#region src/events.ts
const ACCOUNT_LEVEL = /* @__PURE__ */ new Set([
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
			source: {
				type: ACCOUNT_LEVEL.has(type) ? "artifacts" : "artifacts.repo",
				namespace,
				repoName
			},
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
		for (const l of this.listeners) Promise.resolve().then(() => l(event)).catch(() => {});
		return event;
	}
};
/** POST each event as JSON to a URL, the local stand-in for a Queue consumer. */
function webhookListener(url, fetchImpl = fetch) {
	return async (event) => {
		await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(event)
		});
	};
}
//#endregion
//#region src/capabilities.ts
/** Split a pkt-line stream. Throws on malformed framing. */
function parsePkts(data) {
	const out = [];
	let pos = 0;
	while (pos < data.length) {
		const len = Number.parseInt(data.subarray(pos, pos + 4).toString("latin1"), 16);
		if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${pos}`);
		if (len === 0) out.push("flush");
		else if (len === 1) out.push("delim");
		else if (len < 4 || pos + len > data.length) throw new Error(`bad pkt-line length ${len} at ${pos}`);
		else out.push(data.subarray(pos + 4, pos + len));
		pos += len < 4 ? 4 : len;
	}
	return out;
}
function encodePkts(pkts) {
	return Buffer.concat(pkts.map((p) => {
		if (p === "flush") return Buffer.from("0000");
		if (p === "delim") return Buffer.from("0001");
		return Buffer.concat([Buffer.from((p.length + 4).toString(16).padStart(4, "0")), p]);
	}));
}
const AGENT = "agent=artifacts-local";
/** upload-pack v0/v1 capabilities, in the live order. `symref=` and `object-format=` keep git's value. */
const UPLOAD_PACK_V0 = [
	AGENT,
	"object-format",
	"multi_ack",
	"multi_ack_detailed",
	"no-done",
	"side-band",
	"side-band-64k",
	"shallow",
	"deepen-since",
	"deepen-not",
	"deepen-relative",
	"allow-tip-sha1-in-want",
	"allow-reachable-sha1-in-want",
	"no-progress",
	"symref"
];
/** receive-pack capabilities, in the live order: no atomic, push-options, quiet, or report-status-v2. */
const RECEIVE_PACK = [
	"report-status",
	"delete-refs",
	"ofs-delta",
	"side-band-64k",
	"symref"
];
/** upload-pack v2 capability lines, in the live order. */
const UPLOAD_PACK_V2 = [
	AGENT,
	"ls-refs=unborn",
	"fetch=shallow filter sideband-all",
	"object-format=sha1"
];
/** Keep only `allowed` capabilities (by name), in `allowed`'s order; names without `=` in the list keep git's value. */
function filterCapabilities(caps, allowed) {
	const byName = new Map(caps.map((c) => [c.split("=")[0], c]));
	const out = [];
	for (const want of allowed) if (want.includes("=")) out.push(want);
	else if (byName.has(want)) out.push(byName.get(want));
	return out;
}
/** Rewrite the capabilities on the first ref line of a v0/v1 advertisement. */
function rewriteV0(pkts, service) {
	const allowed = service === "git-upload-pack" ? UPLOAD_PACK_V0 : RECEIVE_PACK;
	const i = pkts.findIndex((p) => p instanceof Buffer && p.includes(0));
	if (i === -1) return pkts;
	const line = pkts[i];
	const nul = line.indexOf(0);
	const caps = line.subarray(nul + 1).toString("latin1").replace(/\n$/, "").split(" ").filter(Boolean);
	const next = [...pkts];
	next[i] = Buffer.concat([line.subarray(0, nul + 1), Buffer.from(`${filterCapabilities(caps, allowed).join(" ")}\n`)]);
	return next;
}
/** Replace a v2 capability advertisement with the live one, behind a `# service=` line as live sends. */
function rewriteV2(service) {
	return [
		Buffer.from(`# service=${service}\n`),
		"flush",
		Buffer.from("version 2\n"),
		...UPLOAD_PACK_V2.map((c) => Buffer.from(`${c}\n`)),
		"flush"
	];
}
/** Rewrite an `info/refs` response body. Unrecognised input is returned unchanged. */
function rewriteAdvertisement(body, service) {
	let pkts;
	try {
		pkts = parsePkts(body);
	} catch {
		return body;
	}
	if (pkts.some((p) => p instanceof Buffer && p.toString("latin1") === "version 2\n")) return service === "git-upload-pack" ? encodePkts(rewriteV2(service)) : body;
	return encodePkts(rewriteV0(pkts, service));
}
/** git config that makes git honour what the rewritten advertisement offers. */
const CAPABILITY_CONFIG = [
	["uploadpack.allowTipSHA1InWant", "true"],
	["uploadpack.allowReachableSHA1InWant", "true"],
	["uploadpack.allowSidebandAll", "true"],
	["receive.advertiseAtomic", "false"],
	["receive.advertisePushOptions", "false"]
];
//#endregion
//#region src/tokens.ts
const DEFAULT_TTL = 86400;
const MAX_TTL = 31536e3;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** 16 lowercase base-36 characters, the shape of repo and token IDs in the docs. */
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
	if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 31536e3) throw new ArtifactsError("INVALID_TTL", `ttl must be between 60 and ${MAX_TTL} seconds`, "/ttl");
	return ttl;
}
function issueToken(scope, ttl, now) {
	const s = resolveScope(scope);
	const t = resolveTtl(ttl);
	const secret = `art_v2_x_${randomBytes(20).toString("hex")}`;
	const expiresSec = Math.floor(now / 1e3) + t;
	return {
		record: {
			id: newId(),
			scope: s,
			secretHash: hashSecret(secret),
			createdAt: new Date(now).toISOString(),
			expiresAt: (/* @__PURE__ */ new Date(expiresSec * 1e3)).toISOString(),
			revokedAt: null
		},
		plaintext: `${secret}?expires=${expiresSec}`
	};
}
/**
* Accepts the full token (`art_v2_x_<hex>?expires=<n>`) or just the secret part. The live service
* issues `art_v2_x_`; the docs still describe `art_v1_`, which is accepted too.
* Returns the secret, or null if the string is not token-shaped.
*/
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
//#endregion
//#region src/store.ts
/** Hooks shipped with the package; see hooks/pre-receive. */
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const SORT_FIELDS = {
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
	} catch {}
	throw new ArtifactsError("INVALID_INPUT", "Invalid cursor");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
		this.maxBlobBytes = opts.maxBlobBytes ?? 33554432;
		this.trackPushTimes = opts.trackPushTimes ?? false;
	}
	iso() {
		return new Date(this.now()).toISOString();
	}
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
	async createNamespace(name, jurisdiction) {
		const ns = assertNamespaceName(name);
		if (jurisdiction !== void 0 && jurisdiction !== null && jurisdiction !== "eu" && jurisdiction !== "us") throw new ArtifactsError("INVALID_INPUT", "Invalid option: expected one of \"eu\"|\"us\"", "/jurisdiction");
		await mkdir(this.dataDir, { recursive: true });
		try {
			await mkdir(this.namespaceDir(ns));
		} catch (e) {
			if (e.code === "EEXIST") throw new ArtifactsError("ALREADY_EXISTS", "Namespace already exists");
			throw e;
		}
		const at = this.iso();
		const meta = {
			name: ns,
			jurisdiction: jurisdiction ?? null,
			createdAt: at,
			updatedAt: at
		};
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
			names = (await readdir(this.dataDir)).toSorted();
		} catch {}
		const all = [];
		for (const n of names) {
			const meta = await readJson(join(this.dataDir, n, "namespace.json"));
			if (meta) all.push(meta);
		}
		return {
			items: all.slice(offset, offset + limit),
			total: all.length,
			nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : void 0
		};
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
		await rm(this.namespaceDir(ns), {
			recursive: true,
			force: true
		});
	}
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
			if (e.code === "EEXIST") throw new ArtifactsError("ALREADY_EXISTS", `repo already exists: ${repo}`);
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
	async createRepo(nsName, repoName, opts = {}) {
		const ns = assertNamespaceName(nsName);
		const repo = assertRepoName(repoName);
		const defaultBranch = opts.defaultBranch ?? "main";
		if ((await git([
			"check-ref-format",
			"--branch",
			defaultBranch
		])).code !== 0 || defaultBranch.startsWith("-")) throw new ArtifactsError("INVALID_INPUT", `Invalid default branch: ${JSON.stringify(defaultBranch)}`);
		const dir = await this.reserve(ns, repo);
		try {
			await gitOk([
				"init",
				"-q",
				"--bare",
				"-b",
				defaultBranch,
				dir
			]);
			await this.configureRepo(dir);
			const meta = this.newMeta(ns, repo, {
				description: opts.description ?? null,
				defaultBranch,
				readOnly: opts.readOnly ?? false
			});
			await this.writeMeta(meta);
			await writeJson(this.tokensPath(ns, repo), []);
			this.events.emit("cf.artifacts.repo.created", ns, repo, this.eventPayload(meta));
			return {
				meta,
				token: await this.initialToken(meta)
			};
		} catch (e) {
			await rm(dir, {
				recursive: true,
				force: true
			});
			throw e;
		}
	}
	/** Server-side git settings that match the documented protocol support. */
	async configureRepo(dir) {
		const set = (k, v) => gitOk([
			"--git-dir",
			dir,
			"config",
			k,
			v
		]);
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
		await rm(this.gitDir(ns, repo), {
			recursive: true,
			force: true
		});
		const tombstones = await readJson(this.tombstonesPath(ns)) ?? {};
		tombstones[repo] = meta.id;
		await writeJson(this.tombstonesPath(ns), tombstones);
		this.events.emit("cf.artifacts.repo.deleted", ns, repo, this.eventPayload(meta));
		return meta;
	}
	async listRepos(nsName, opts = {}) {
		const ns = assertNamespaceName(nsName);
		const limit = opts.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ArtifactsError("INVALID_INPUT", limit < 1 ? "Too small: expected number to be >0" : "Too big: expected number to be <=200", "/limit");
		const sort = opts.sort ?? "created_at";
		if (!(sort in SORT_FIELDS)) throw new ArtifactsError("INVALID_INPUT", "Invalid option: expected one of \"created_at\"|\"updated_at\"|\"last_push_at\"|\"name\"", "/sort");
		const direction = opts.direction ?? "desc";
		if (direction !== "asc" && direction !== "desc") throw new ArtifactsError("INVALID_INPUT", "Invalid option: expected one of \"asc\"|\"desc\"", "/direction");
		const offset = decodeCursor(opts.cursor);
		let entries = [];
		try {
			entries = await readdir(join(this.namespaceDir(ns), "repos"));
		} catch {}
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
		return {
			repos: all.slice(offset, offset + limit),
			total: all.length,
			nextCursor: offset + limit < all.length ? encodeCursor(offset + limit) : void 0
		};
	}
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
			await rm(dir, {
				recursive: true,
				force: true
			});
			await rename(tmp, dir);
			const ready = {
				...meta,
				status: "ready",
				updatedAt: this.iso()
			};
			await this.writeMeta(ready);
			await writeJson(this.tokensPath(meta.namespace, meta.name), []);
			return ready;
		} catch (e) {
			await rm(tmp, {
				recursive: true,
				force: true
			});
			await rm(dir, {
				recursive: true,
				force: true
			});
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
			description: opts.description ?? null,
			defaultBranch: src.defaultBranch,
			readOnly: opts.readOnly ?? false,
			source: `artifacts:${ns}/${src.name}`,
			status: "forking"
		});
		const ready = await this.materialize(dir, meta, async (tmp) => {
			if (!((await git([
				"--git-dir",
				srcDir,
				"rev-parse",
				"--verify",
				"--quiet",
				"HEAD"
			])).code === 0)) {
				await gitOk([
					"init",
					"-q",
					"--bare",
					"-b",
					src.defaultBranch,
					tmp
				]);
				return;
			}
			await gitOk([
				"clone",
				"-q",
				"--bare",
				srcDir,
				tmp
			]);
			await gitOk([
				"--git-dir",
				tmp,
				"remote",
				"remove",
				"origin"
			]);
		});
		const objects = await countObjects(dir);
		this.events.emit("cf.artifacts.repo.forked", ns, src.name, {
			namespace: ns,
			repoName: target,
			...this.eventPayload(ready)
		});
		return {
			meta: ready,
			token: await this.initialToken(ready),
			objects
		};
	}
	async importRepo(nsName, repoName, params) {
		const ns = assertNamespaceName(nsName);
		const target = assertRepoName(repoName);
		const url = params.url;
		if (typeof url !== "string" || !url) throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
		if (!this.allowInsecureImport && !url.startsWith("https://")) throw new ArtifactsError("INVALID_INPUT", "Must be an HTTPS URL", "/url");
		if (params.depth !== void 0 && (!Number.isInteger(params.depth) || params.depth < 1)) throw new ArtifactsError("INVALID_INPUT", "Too small: expected number to be >0", "/depth");
		if (params.branch !== void 0 && (typeof params.branch !== "string" || !params.branch || params.branch.startsWith("-"))) throw new ArtifactsError("INVALID_INPUT", "Invalid branch", "/branch");
		const dir = await this.reserve(ns, target);
		const meta = this.newMeta(ns, target, {
			description: params.description ?? null,
			readOnly: params.readOnly ?? false,
			source: importSource(url),
			status: "importing"
		});
		let head = "main";
		const final = {
			...await this.materialize(dir, meta, async (tmp) => {
				const args = [
					"clone",
					"-q",
					"--bare",
					"--single-branch"
				];
				if (params.branch) args.push("--branch", params.branch);
				if (params.depth) args.push("--depth", String(params.depth));
				const r = await git([
					...args,
					"--end-of-options",
					url,
					tmp
				]);
				if (r.code !== 0) throw importError(r.stderr, url.endsWith(".git") ? url : `${url}.git`);
				await gitOk([
					"--git-dir",
					tmp,
					"remote",
					"remove",
					"origin"
				]);
				head = (await gitOk([
					"--git-dir",
					tmp,
					"symbolic-ref",
					"--short",
					"HEAD"
				])).toString().trim();
			}),
			defaultBranch: params.branch ?? "main"
		};
		await this.writeMeta(final);
		this.events.emit("cf.artifacts.repo.imported", ns, target, {
			...this.eventPayload(final),
			sourceUrl: url,
			branch: head
		});
		return {
			meta: final,
			token: await this.initialToken(final)
		};
	}
	async recordPush(ns, repo) {
		const meta = await this.readMeta(ns, repo);
		if (!meta) return;
		const at = this.iso();
		await this.writeMeta({
			...meta,
			updatedAt: at,
			lastPushAt: at
		});
	}
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
		return {
			info: toTokenInfo(record, this.now()),
			plaintext
		};
	}
	async listTokens(ns, repo, state = "all") {
		await this.getReadyRepo(ns, repo);
		const now = this.now();
		return (await this.readTokens(ns, repo)).map((r) => toTokenInfo(r, now)).filter((t) => state === "all" || t.state === state);
	}
	/** Revoke by token id or plaintext. Returns false when no token matches. */
	async revokeToken(ns, repo, tokenOrId) {
		if (typeof tokenOrId !== "string" || !tokenOrId) throw new ArtifactsError("INVALID_INPUT", "tokenOrId must be a non-empty string");
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
			const page = await this.listRepos(ns, {
				limit: 200,
				cursor
			});
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
/** Live: `git:<url>`, with `.git` appended when missing (`git:https://github.com/o/r.git`). */
function importSource(url) {
	return `git:${url.replace(/\/+$/, "").replace(/(?<!\.git)$/, ".git")}`;
}
function importError(stderr, url = "") {
	const s = stderr.toLowerCase();
	if (/could not read username|authentication failed|terminal prompts disabled|401|403/.test(s)) return new ArtifactsError("REMOTE_AUTH_REQUIRED", `Repository "${url}" requires authentication (HTTP 401). Only public repositories can be imported.`, "/url");
	if (/could not resolve host|failed to connect|connection refused|timed out|unable to access/.test(s)) return new ArtifactsError("UPSTREAM_UNAVAILABLE", "The remote git server could not be reached", "/url");
	if (/not found|does not exist|404/.test(s)) return new ArtifactsError("INVALID_URL", "url must be an HTTPS git remote URL (e.g. https://github.com/owner/repo)", "/url");
	return new ArtifactsError("INVALID_URL", "url must be an HTTPS git remote URL (e.g. https://github.com/owner/repo)", "/url");
}
//#endregion
//#region src/git-http.ts
const ZERO = "0".repeat(40);
const MAX_PUSH_COMMITS = 20;
const ROUTE = /^\/git\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/;
function parseGitRoute(method, pathname, query) {
	const m = ROUTE.exec(pathname);
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
	return {
		ns,
		repo,
		service,
		path: tail
	};
}
/** Bearer `<full token>` or `<secret>`, or Basic with any user (live accepts an empty one) and the secret as password. */
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
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		...headers
	});
	res.end(`${message}\n`);
}
async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks);
}
/**
* Wants and haves in an upload-pack request: no haves means a clone. Whether this round actually
* transferred objects is decided from the response (see `PackDetector`), because a protocol v2
* client sends no `done` when the server can answer `ready` with the pack straight away.
*/
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
/** Spots a packfile (`PACK` on sideband channel 1) in a streamed upload-pack response. */
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
	const r = await git([
		"--git-dir",
		gitDir,
		"for-each-ref",
		"--format=%(objectname) %(refname)"
	]);
	const map = /* @__PURE__ */ new Map();
	for (const line of r.stdout.toString().split("\n")) {
		if (!line) continue;
		const sp = line.indexOf(" ");
		map.set(line.slice(sp + 1), line.slice(0, sp));
	}
	return map;
}
/** Payloads for `cf.artifacts.repo.pushed`, one per updated ref. */
async function pushPayloads(gitDir, before, after) {
	const refs = /* @__PURE__ */ new Set([...before.keys(), ...after.keys()]);
	const payloads = [];
	for (const ref of [...refs].toSorted()) {
		const b = before.get(ref) ?? ZERO;
		const a = after.get(ref) ?? ZERO;
		if (a === b) continue;
		let hashes = [];
		if (a !== ZERO) hashes = (await git([
			"--git-dir",
			gitDir,
			"rev-list",
			a,
			...[...new Set(before.values())].map((h) => `^${h}`)
		])).stdout.toString().split("\n").filter(Boolean);
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
					timestamp: (/* @__PURE__ */ new Date(c.committedAt * 1e3)).toISOString(),
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
/** Serialise pushes per repo so ref snapshots attribute updates to the right push. */
const pushLocks = /* @__PURE__ */ new Map();
function withLock(key, fn) {
	const next = (pushLocks.get(key) ?? Promise.resolve()).then(fn, fn);
	pushLocks.set(key, next.catch(() => {}));
	return next;
}
/** Run `git http-backend` as a CGI and stream its response. */
function runBackend(store, route, req, res, query, opts = {}) {
	const gitDir = store.gitDir(route.ns, route.repo);
	const env = {
		...process.env,
		...ISOLATED_GIT_ENV,
		GIT_PROJECT_ROOT: dirname(gitDir),
		GIT_HTTP_EXPORT_ALL: "1",
		PATH_INFO: `/${route.repo}.git${route.path}`,
		REQUEST_METHOD: req.method ?? "GET",
		QUERY_STRING: query,
		CONTENT_TYPE: req.headers["content-type"] ?? "",
		REMOTE_USER: "artifacts",
		REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
		ARTIFACTS_MAX_BLOB_BYTES: String(store.maxBlobBytes)
	};
	if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
	const config = [["core.hooksPath", HOOKS_DIR], ...CAPABILITY_CONFIG];
	const proto = req.headers["git-protocol"];
	if (route.service === "git-upload-pack" && typeof proto === "string") {
		env.GIT_PROTOCOL = proto;
		if (/version=2/.test(proto)) config.push(["uploadpack.allowFilter", "true"]);
	}
	env.GIT_CONFIG_COUNT = String(config.length);
	config.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["http-backend"], {
			env,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		let headerBuf = Buffer.alloc(0);
		let headersSent = false;
		let status = 200;
		const held = [];
		const send = (chunk) => {
			opts.tap?.(chunk);
			if (opts.transform) held.push(chunk);
			else res.write(chunk);
		};
		child.stdout.on("data", (chunk) => {
			if (headersSent) {
				send(chunk);
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
				else if (!(opts.transform && k.toLowerCase() === "content-length")) headers[k] = v;
			}
			res.writeHead(status, headers);
			headersSent = true;
			const rest = headerBuf.subarray(end + sepLen);
			if (rest.length) send(rest);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (!headersSent) plain(res, 500, "git http-backend failed");
			else {
				if (opts.transform) res.write(opts.transform(Buffer.concat(held)));
				if (!opts.keepOpen) res.end();
			}
			resolve(code === 0 ? status : 500);
		});
		child.stdin.on("error", () => {});
		if (opts.body) child.stdin.end(opts.body);
		else req.pipe(child.stdin);
	});
}
/** Handle a Git smart HTTP request. Returns false when the path is not a git route. */
async function handleGit(store, req, res, url) {
	const route = parseGitRoute(req.method ?? "GET", url.pathname, url.searchParams);
	if (!route) {
		if (url.pathname.startsWith("/git/")) {
			plain(res, 404, "Not found");
			return true;
		}
		return false;
	}
	try {
		await store.getReadyRepo(route.ns, route.repo);
	} catch (e) {
		const err = e;
		plain(res, err.status ?? 500, err.message);
		return true;
	}
	const needed = route.service === "git-receive-pack" ? "write" : "read";
	const token = presentedToken(req.headers.authorization);
	if (!token) {
		plain(res, 401, "Authentication required", { "www-authenticate": "Basic realm=\"Artifacts\"" });
		return true;
	}
	const auth = await store.authenticate(route.ns, route.repo, token, needed);
	if (auth === "unauthorized") {
		plain(res, 403, "Invalid or expired token");
		return true;
	}
	if (auth === "forbidden") {
		plain(res, 403, "Insufficient permissions");
		return true;
	}
	const query = url.search.slice(1);
	const advertise = (body) => rewriteAdvertisement(body, route.service);
	if (route.service === "git-upload-pack") {
		if (route.path === "/info/refs") {
			await runBackend(store, route, req, res, query, { transform: advertise });
			return true;
		}
		const body = await readBody(req);
		const kind = classifyUploadPack(body, req.headers["content-encoding"]);
		const pack = new PackDetector();
		if (await runBackend(store, route, req, res, query, {
			body,
			tap: (c) => pack.push(c)
		}) === 200 && kind !== "none" && pack.found) store.events.emit(kind === "clone" ? "cf.artifacts.repo.cloned" : "cf.artifacts.repo.fetched", route.ns, route.repo, {});
		return true;
	}
	if (route.path === "/info/refs") {
		await runBackend(store, route, req, res, query, { transform: advertise });
		return true;
	}
	const gitDir = store.gitDir(route.ns, route.repo);
	await withLock(gitDir, async () => {
		const before = await refSnapshot(gitDir);
		try {
			await runBackend(store, route, req, res, query, { keepOpen: true });
			const after = await refSnapshot(gitDir);
			const payloads = await pushPayloads(gitDir, before, after);
			if (payloads.length) {
				if (store.trackPushTimes) await store.recordPush(route.ns, route.repo);
				for (const p of payloads) store.events.emit("cf.artifacts.repo.pushed", route.ns, route.repo, p);
			}
		} finally {
			res.end();
		}
	});
	return true;
}
//#endregion
//#region src/rest.ts
const REST_PREFIX = /^\/client\/v4\/accounts\/([^/]+)\/artifacts(\/.*)?$/;
function send(res, reply) {
	if (reply.empty) {
		res.writeHead(reply.status);
		res.end();
		return;
	}
	if (reply.bytes) {
		res.writeHead(reply.status, {
			"content-type": reply.bytes.type,
			"content-length": reply.bytes.data.length
		});
		res.end(reply.bytes.data);
		return;
	}
	const body = {
		result: reply.result ?? null,
		success: true,
		errors: [],
		messages: []
	};
	if (reply.resultInfo) body.result_info = reply.resultInfo;
	res.writeHead(reply.status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
function sendError(res, status, errors) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({
		result: null,
		success: false,
		errors,
		messages: []
	}));
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
/**
* Live pagination info (2026-10-08): cursor-style while more pages follow, offset-style once
* everything fits, e.g. `{page: 1, per_page: 50, total_pages: 0, count: 0, total_count: 0}`.
*/
function listInfo(nextCursor, perPage, count, total) {
	if (nextCursor) return {
		cursor: nextCursor,
		per_page: perPage,
		count
	};
	return {
		page: 1,
		per_page: perPage,
		total_pages: Math.ceil(total / perPage),
		count,
		total_count: total
	};
}
function created(store, m, token) {
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
	return {
		id: t.id,
		scope: t.scope,
		state: t.state,
		created_at: t.createdAt,
		expires_at: t.expiresAt
	};
}
function treeInfo(e) {
	return {
		name: e.name,
		mode: e.mode,
		hash: e.hash,
		type: e.type
	};
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
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArtifactsError("INVALID_INPUT", "Request body must be a JSON object");
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
const TOKEN_STATES = /* @__PURE__ */ new Set([
	"active",
	"expired",
	"revoked",
	"all"
]);
async function route(store, req, sub, q) {
	const method = req.method ?? "GET";
	const parts = sub.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts[0] !== "namespaces") return noRoute();
	if (parts.length === 1) {
		if (method === "POST") {
			const body = await jsonBody(req);
			return {
				status: 201,
				result: await namespaceInfo(store, await store.createNamespace(body.namespace, body.jurisdiction))
			};
		}
		if (method === "GET") {
			const limit = intParam(q, "limit") ?? 50;
			const page = await store.listNamespaces({
				limit,
				cursor: q.get("cursor") ?? void 0
			});
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
		if (method === "GET") return {
			status: 200,
			result: await namespaceInfo(store, await store.getNamespace(ns))
		};
		if (method === "DELETE") {
			await store.deleteNamespace(ns);
			return {
				status: 204,
				empty: true
			};
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
				result: {
					id: t.info.id,
					plaintext: t.plaintext,
					scope: t.info.scope,
					expires_at: t.info.expiresAt
				}
			};
		}
		if (parts.length === 4 && method === "DELETE") {
			const id = parts[3];
			if (await store.revokeTokenById(ns, id) === "missing") notFound("Token not found");
			return {
				status: 200,
				result: { id }
			};
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
			return {
				status: 201,
				result: created(store, r.meta, r.token)
			};
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
				result: page.repos.map((m) => ({
					...repoInfo(store, m),
					status: m.status
				})),
				resultInfo: listInfo(page.nextCursor, limit, page.repos.length, page.total)
			};
		}
		return noRoute();
	}
	const name = parts[3];
	const action = parts[4];
	if (parts.length === 4) {
		if (method === "GET") return {
			status: 200,
			result: repoInfo(store, await store.getReadyRepo(ns, name))
		};
		if (method === "DELETE") return {
			status: 202,
			result: { id: (await store.deleteRepo(ns, name))?.id ?? await store.deletedRepoId(ns, name) ?? notFound("Repository not found") }
		};
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
		return {
			status: 201,
			result: created(store, r.meta, r.token)
		};
	}
	if (action === "fork" && parts.length === 5 && method === "POST") {
		const body = await jsonBody(req);
		const r = await store.forkRepo(ns, name, body.name, {
			description: optString(body, "description"),
			readOnly: optBool(body, "read_only"),
			defaultBranchOnly: optBool(body, "default_branch_only")
		});
		return {
			status: 201,
			result: {
				...created(store, r.meta, r.token),
				objects: r.objects
			}
		};
	}
	if (method !== "GET") return noRoute();
	await store.getReadyRepo(ns, name);
	const gitDir = store.gitDir(ns, name);
	switch (action) {
		case "log":
			if (parts.length !== 5) return noRoute();
			return {
				status: 200,
				result: await log(gitDir, {
					ref: q.get("ref") || void 0,
					limit: intParam(q, "limit"),
					offset: intParam(q, "offset")
				})
			};
		case "commit":
			if (parts.length !== 6) return noRoute();
			return {
				status: 200,
				result: await readCommit(gitDir, parts[5]) ?? notFound("Commit not found")
			};
		case "tree":
			if (parts.length !== 6) return noRoute();
			return {
				status: 200,
				result: (await readTree(gitDir, parts[5]) ?? notFound("Tree not found")).map(treeInfo)
			};
		case "blob":
			if (parts.length !== 6) return noRoute();
			return {
				status: 200,
				bytes: {
					data: await readBlob(gitDir, parts[5]) ?? notFound("Blob not found"),
					type: "application/octet-stream"
				}
			};
		case "file":
			if (parts.length !== 5) return noRoute();
			return {
				status: 200,
				bytes: {
					data: await readFileAt(gitDir, q.get("ref") ?? "", q.get("path") ?? "") ?? notFound("File not found"),
					type: "application/octet-stream"
				}
			};
		case "raw": {
			const [ref, ...rest] = parts.slice(5);
			if (!ref || rest.length === 0) notFound("File not found");
			const f = await readFileAt(gitDir, ref, rest.join("/")) ?? notFound("File not found");
			return {
				status: 200,
				bytes: {
					data: f,
					type: sniffContentType(f).replace(";charset", "; charset")
				}
			};
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
var NoRoute = class extends Error {};
function noRoute() {
	throw new NoRoute();
}
/** Handle a REST request. Returns false when the path is not an Artifacts REST route. */
async function handleRest(store, req, res, url, opts = {}) {
	const m = REST_PREFIX.exec(url.pathname);
	if (!m) return false;
	const auth = req.headers.authorization ?? "";
	const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
	if (!bearer || opts.apiToken !== void 0 && bearer !== opts.apiToken) {
		sendError(res, 401, [{
			code: 1e4,
			message: "Authentication error"
		}]);
		return true;
	}
	if (opts.accountId !== void 0 && m[1] !== opts.accountId) {
		sendError(res, 403, [{
			code: 1e4,
			message: "Authentication error"
		}]);
		return true;
	}
	try {
		send(res, await route(store, req, m[2] ?? "", url.searchParams));
	} catch (e) {
		if (e instanceof NoRoute) {
			res.writeHead(404, { "content-type": "text/plain; charset=UTF-8" });
			res.end("404 Not Found");
		} else if (e instanceof ArtifactsError) sendError(res, e.status, [e.toApiError()]);
		else sendError(res, 500, [{
			code: 10400,
			message: e instanceof Error ? e.message : "Internal error"
		}]);
	}
	return true;
}
//#endregion
//#region src/server.ts
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
		(s, req, res, url) => handleRest(s, req, res, url, opts),
		handleGit,
		...extra
	];
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		try {
			for (const h of handlers) if (await h(store, req, res, url)) return;
			sendError(res, 404, [{
				code: 7e3,
				message: "No route for that URI"
			}]);
		} catch (e) {
			if (!res.headersSent) sendError(res, 500, [{
				code: 10400,
				message: e instanceof Error ? e.message : "Internal error"
			}]);
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
//#endregion
export { handleBinding as a, webhookListener as i, Store as n, EventBus as r, startServer as t };
