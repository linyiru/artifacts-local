# Emulated behavior

What artifacts-local reproduces from Cloudflare Artifacts, and where each rule
comes from. Sources (fetched 2026-10-08):

- **[docs]** <https://developers.cloudflare.com/artifacts/llms-full.txt>
  (REST API, Workers binding, Git protocol, Errors, Limits, Event subscriptions)
- **[types]** `@cloudflare/workers-types@5.20261008.1`, `interface Artifacts*`

Status: **doc** = taken from the sources above, not yet checked against the
live service. **live 2026-10-08** = observed on the real service; those rules are
pinned by `test/fixtures/live.json` (replayed by `test/fixtures.test.ts`) and by
`test/contract` (run with `npm run test:live`). Where live and the docs disagree,
the emulator follows live.

## Names

| Rule | Source | Status |
|---|---|---|
| Namespace and repo names start with a letter or digit; the rest is letters, digits, `.`, `_`, `-` (live error: `must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`) | [docs] Limits | live 2026-10-08 |
| Namespace name length 2–63 | [docs] Limits | doc |
| Repo name length: not documented; emulated as 1–63 | — | guess |
| Creating a repo in a missing namespace creates the namespace | [docs] Namespaces | doc |

## Errors

Binding throws `ArtifactsError { name, code, numericCode }`; REST returns the v4
envelope with `errors[].code` = the numeric code.

| Code | Numeric | HTTP (emulated) |
|---|---|---|
| `INVALID_INPUT` | 10100 | 400 |
| `INVALID_REPO_NAME` | 10101 | 400 |
| `INVALID_TTL` | 10103 | 400 |
| `INVALID_URL` | 10104 | 400 |
| `REMOTE_AUTH_REQUIRED` | 10106 | 400 |
| `NOT_FOUND` | 10200 | 404 |
| `ALREADY_EXISTS` | 10201 | 409 |
| `CREATE_IN_PROGRESS` | 10301 (guess, not in docs table) | 409 |
| `IMPORT_IN_PROGRESS` | 10302 | 409 |
| `FORK_IN_PROGRESS` | 10303 | 409 |
| `INTERNAL_ERROR` | 10400 | 500 |
| `UPSTREAM_UNAVAILABLE` | 10401 | 502 |
| `MEMORY_LIMIT` | 10402 | 413 |

Numeric codes: [docs] Errors. HTTP statuses: live 2026-10-08 for 400, 404, 409,
422 (`REMOTE_AUTH_REQUIRED`), and 500; the rest are guesses. Successful creates
(namespace, repo, token, fork, import) are `201`; repo delete is `202`;
namespace delete is `204` with no body (live).

## Tokens

| Rule | Source |
|---|---|
| Format `art_v2_x_<40 hex>?expires=<unix seconds>` (the docs say `art_v1_`; both are accepted) | live 2026-10-08 |
| Scope `read` (clone/fetch/pull) or `write` (also push); default `write` | [docs], [types] |
| TTL default 86400 s, min 60, max 31536000, else `INVALID_TTL` | [types] |
| `revokeToken` accepts plaintext or id; `false` if unknown; `INVALID_INPUT` if empty | [types] |
| State `active` / `expired` / `revoked` | [docs] |
| REST token list defaults to `state=active`, `per_page` 30 (max 100) | [docs] REST |
| Create, fork, import return the token string only; `POST /tokens` returns `{id, plaintext, scope, expires_at}` | [docs] REST |

## Git smart HTTP

| Rule | Source |
|---|---|
| Remote `…/git/<namespace>/<repo>.git` | [docs] |
| Auth: `Authorization: Bearer <full token or secret>`, or Basic with any user (an empty one works live) and the secret (token without `?expires=`) as password | [docs], live 2026-10-08 |
| No credentials → 401; an invalid, expired, or revoked token → 403 `Invalid or expired token`; a read token pushing → 403 `Insufficient permissions` | live 2026-10-08 |
| upload-pack: v1 and v2 | [docs] |
| receive-pack: v1 only; v2 not supported | [docs] |
| `filter` (partial clone) works over protocol v2 and is ignored over v0/v1 ("filtering not recognized by server") | [docs] (v1), live 2026-10-08 |
| From a blobless clone, reading one missing blob fetches only that blob (promisor fetch), which is what ArtifactFS relies on | live 2026-10-08 |
| A push does not change `last_push_at` or `updated_at` (unchanged 15 s after a push). `--track-push-times` opts back in | live 2026-10-08 |
| `read_only` does **not** stop a push made with a write token; it is stored and reported only | live 2026-10-08 |
| The server is not git: it reports `agent=gitty/1.0` (emulated as `agent=artifacts-local`) | live 2026-10-08 |
| isomorphic-git (1.42) pushes and clones with Basic auth (`x` and the token secret), from Node and from a Worker, as in the docs' example | live 2026-10-08 (Node); emulator also tested inside workerd |
| upload-pack v0/v1 advertises, in order: `agent object-format multi_ack multi_ack_detailed no-done side-band side-band-64k shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress symref`; no `include-tag`, `thin-pack`, or `ofs-delta` | [docs] (include-tag), live 2026-10-08 |
| upload-pack v2 advertises `ls-refs=unborn`, `fetch=shallow filter sideband-all`, `object-format=sha1`, behind a `# service=` line; no `wait-for-done` or `server-option` | live 2026-10-08 |
| receive-pack leads with `HEAD` and advertises `report-status delete-refs ofs-delta side-band-64k symref`; no `atomic`, `push-options`, `quiet`, or `report-status-v2`, so `git push --atomic` and `git push -o` fail on the client ("the receiving end does not support …") | live 2026-10-08 |

## Repo content (binding and REST)

| Rule | Source |
|---|---|
| `log`: first-parent, newest first, `ref` default `HEAD`, `limit` default 50 (max 1000), `offset`; `[]` for unknown ref | [types] |
| `readCommit` / `readTree` / `readBlob`: hash must be lowercase 40-hex, else `INVALID_INPUT`; `null` if missing | [types] |
| `readTree` returns immediate children `{name, mode, hash, type}`; `type` is `tree`/`blob`/`symlink`/`gitlink`/`exec` | [types] |
| `readBlob` returns an untyped Blob; `null` if not a blob | [types] |
| `readFile` returns a MIME-typed Blob (`text/plain;charset=utf-8` or `application/octet-stream`); `null` for missing or directory | [docs] |
| Commit message has one trailing newline removed | [types] |
| REST `file` → `application/octet-stream`; `raw/:ref/:path` → `text/plain; charset=utf-8` (with a space) or `application/octet-stream` | [docs], live 2026-10-08 |
| `raw/:ref/:path` takes the first segment as the ref, so a ref containing `/` cannot be read through it | live 2026-10-08 |
| REST JSON for log/commit/tree is the binding's camelCase shape (`treeHash`, `authoredAt`) | live 2026-10-08 |

## Fork, import, delete

| Rule | Source |
|---|---|
| Fork is async: listed with `status: forking`; `get()` throws `FORK_IN_PROGRESS` until ready | [docs], [types] |
| Fork copies every branch and tag; `default_branch_only` / `defaultBranchOnly` is accepted and ignored. (The types say the binding defaults to `true`; REST ignores the flag either way.) | live 2026-10-08 (REST); binding unverified |
| A fork's description is `null` unless given; it is not copied from the source | live 2026-10-08 |
| Fork `source` is `artifacts:<namespace>/<repo>`; REST fork result adds `objects` | [types], [docs] |
| Import `source` is `git:<url>` with `.git` appended | live 2026-10-08 |
| Import without `branch` reports `default_branch: "main"` even when the remote's default is another branch; the repo's HEAD and branches are the remote's | live 2026-10-08 |
| Import errors: `http://` → 10100; a non-git URL → 10104 (400); a GitHub repo that does not exist → 10106 (422, GitHub answers 401). A 404 from any host is treated as 10104 (guess) | live 2026-10-08 |
| Fork to an existing name → `ALREADY_EXISTS` | [types] |
| Import: HTTPS only (`INVALID_INPUT`), optional `branch`, `depth` | [types] |
| REST delete returns `202 Accepted` with `{id}`; binding returns boolean | [docs] |

## Undocumented, emulated as plain git does it

Checked by hand against git 2.55 (2026-10-08); unverified against the live service.

| Behaviour | Emulated as |
|---|---|
| Push from a shallow clone | Refused (`shallow update not allowed`), git's default `receive.shallowUpdate=false` |
| `fetched` / `cloned` events | Emitted only when a pack is actually sent; a fetch that finds nothing new emits nothing |
| Branch deletion, force push | Allowed, including deleting the default branch (`receive.denyDeleteCurrent=false`) |

## Events and event subscriptions

| Rule | Source |
|---|---|
| Types `cf.artifacts.repo.{created,deleted,forked,imported,pushed,cloned,fetched,token.created,token.revoked}`; payloads as documented | [docs], live 2026-10-08 |
| Field order `type, source{namespace, repoName, type}, metadata, payload` | live 2026-10-08 |
| A subscription sends one source's events to one queue. `artifacts` takes `repo.created`, `repo.deleted`, `repo.forked`, `repo.imported`; `artifacts.repo` takes `pushed`, `cloned`, `fetched`, `token.created`, `token.revoked` and needs `source.namespace` and `source.repo_name` | [docs], live 2026-10-08 (REST; wrangler 4.137 has no repo options) |
| A queue message's body is the event, with `metadata.eventSubscriptionId` set to the subscription's id | live 2026-10-08 |
| Delivery within about 5 s; unacked messages come back after the visibility timeout with `attempts` + 1 | live 2026-10-08 (not emulated: the local Queue handles retries) |
| `repo.forked` was **not** delivered within 60 s of a fork, while the other events were. The emulator still emits it | live 2026-10-08 |

## Metrics

`artifactsEventsAdaptiveGroups` as the live service filled it on 2026-10-08 (GraphQL Analytics):

| Rule | Source |
|---|---|
| Event types: `create` (also import), `fork`, `delete`, `push`, `pull` (clone or fetch that sends a pack), `read` (any read through REST or the binding), `token_create`, `token_revoke`, `namespace_{list,get,create,delete}` | [docs] (first five), live 2026-10-08 |
| Failures: `clientError` with `errorMessage` `"<type> rejected"`, `serverError` with `"<type> failed"` | live 2026-10-08 |
| Git requests refused for credentials were not recorded | live 2026-10-08 |
| `create`, `delete`, `fork`, token, and namespace create/delete operations report a duration of 0 | live 2026-10-08 |
| `storageLimitReached` and `rateLimited` are documented; not seen live, not emulated | [docs] |

## Limits

| Limit | Source | Emulated |
|---|---|---|
| Max file/blob 32 MB | [docs] Limits | Yes: `hooks/pre-receive` refuses the push; refs stay unchanged. The real error text is undocumented (guess). Configurable with `maxBlobBytes`. |
| Max repo 1 GB, account 1 TB | [docs] Limits | No |
| 2000 req / 10 s per namespace (control plane) and per repo (git) | [docs] Limits | No |
