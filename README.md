# artifacts-local

[![CI](https://github.com/linyiru/artifacts-local/actions/workflows/ci.yml/badge.svg)](https://github.com/linyiru/artifacts-local/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/linyiru/artifacts-local)](LICENSE)
[![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Cloudflare Artifacts](https://img.shields.io/badge/emulates-Cloudflare%20Artifacts-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/artifacts/)
[![Last commit](https://img.shields.io/github/last-commit/linyiru/artifacts-local)](https://github.com/linyiru/artifacts-local/commits/main)

A local emulator for [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), so you can
develop against Artifacts without an account, a network, or a bill. Cloudflare ships no local mode for
Artifacts (`cf` marks it "will never have a local simulator"; Miniflare only proxies to the real
service), so this fills that gap.

It reproduces all three Artifacts surfaces, backed by bare Git repositories on disk:

| Surface | Local equivalent |
|---|---|
| Workers binding (`env.ARTIFACTS`) | `worker/shim.ts`, a `WorkerEntrypoint` you bind in place of the real binding under `wrangler dev`; or `createArtifactsBinding()` from `src/client.ts` |
| REST API (`/client/v4/accounts/:id/artifacts/...`) | Same paths, same v4 envelope, same error codes |
| Git smart HTTP (`…/git/<ns>/<repo>.git`) | `git http-backend` behind repo-token auth: Bearer or Basic, read/write scopes, push over protocol v0/v1 only, partial clone (`--filter`) over v2 only |

Also emulated: async fork/import states (`forking`, `importing`, `FORK_IN_PROGRESS`), token TTL
bounds and expiry, the 32 MB per-file limit, and the documented event envelopes
(`cf.artifacts.repo.pushed` and friends), which you can read back or have POSTed to a webhook.

[SPEC.md](SPEC.md) lists every emulated rule, its source, and which ones are guesses because the
docs are silent.

## What Artifacts does not provide

Artifacts is Git storage you can create and fork programmatically. Everything a Git *platform* adds
on top is left to you, and the emulator deliberately does not add it either, so code that works
here works in production. Per the docs, `@cloudflare/workers-types`, and the live service as of
2026-10-08:

| Missing | What Artifacts has instead | Building it yourself |
|---|---|---|
| List, create, or delete branches and tags | Refs only appear as a `ref` parameter to `log()` / `readFile()` | Use `git push` (`git push remote HEAD:refs/heads/x`, `:x` to delete) and `git ls-remote` for listing; or track refs from `cf.artifacts.repo.pushed` events |
| Write commits or files through the API | `git push` with a write token is the only write path | Run `git` in a Container or Sandbox, or use isomorphic-git in a Worker for small repos |
| Diff or compare two refs | `readCommit`, `readTree` (one level), `readBlob` | Walk both trees with `readTree`, skip subtrees whose hashes match, `readBlob` the changed files, line-diff them (e.g. jsdiff) |
| Merge base | `readCommit` gives `parents` | Walk parents from both heads. A fork carries its source's history, so the base is reachable from the fork |
| Merge, rebase, conflict detection | — | Real `git` (Container/Sandbox): clone base, fetch the fork, merge, push |
| Pull requests, code review, issues | Push events (`cf.artifacts.repo.pushed`) | Keep them in D1 or Durable Objects; start review from push events |
| Public or anonymous access | Every Git route needs a repo token; REST needs a Cloudflare API token | A Worker that proxies `git-upload-pack` and adds a short-lived read token; refuse `git-receive-pack`. Mind the 2000 req / 10 s per-repo Git limit (consider `bundle-uri` with bundles in R2) |
| Tarball or zip download | `blob`, `file`, `raw` return one file at a time | Walk the tree, stream a tar through `CompressionStream("gzip")`, cache by commit hash in R2 |
| Write protection | `read_only: true` is stored and reported, but a write token can still push (checked live 2026-10-08) | Issue only read tokens for repos that must not change |
| Atomic pushes and push options | Not advertised: `git push --atomic` and `git push -o` fail (checked live) | Push refs one by one and check each; pass metadata through your own API instead of push options |
| A target namespace on fork | `fork(name)` and REST fork take no namespace (yet the docs' `repo.forked` event example shows a different target namespace) | Clone and push into a repo in the other namespace |
| `filter` over protocol v0/v1; push over protocol v2 | Clone and fetch over v1/v2, push over v0/v1; `--filter` works over v2, and a blobless clone fetches single blobs on demand (both checked live) | Let git negotiate v2 (the default) for partial clones; [ArtifactFS](https://github.com/cloudflare/artifact-fs) mounts a repo this way |

## Requirements

Node 24+ and `git` with `git http-backend`. No runtime dependencies.

## Install

```sh
npm install -D github:linyiru/artifacts-local#v0.3.0   # or pnpm add -D / bun add -d
```

The package runs from compiled JavaScript in `dist/`, so plain `node` works from `node_modules`.
`dist/` is committed, so a `github:` install needs no build step.

## Run the emulator

```sh
npx artifacts-local serve          # http://127.0.0.1:8788, data in ./.artifacts-local
npx artifacts-local serve --help   # port, data dir, webhook, --async-delay, --allow-insecure-import, …
```

In a clone of this repo, `npm start` runs the TypeScript sources directly (Node 24 strips types
outside `node_modules`). After changing `src/`, run `npm run build` and commit `dist/`; `npm run check`
and CI fail when `dist/` is stale.

## Use it from a Worker under `wrangler dev`

Keep the real binding for production, and add a `local` environment that swaps it for the shim:

```jsonc
// your app's wrangler.jsonc
{
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }],
  "env": {
    "local": {
      "services": [
        { "binding": "ARTIFACTS", "service": "artifacts-local-shim", "entrypoint": "ArtifactsLocal",
          "props": { "namespace": "default" } }
      ]
    }
  }
}
```

```sh
npx artifacts-local serve &
wrangler dev -e local -c wrangler.jsonc -c node_modules/artifacts-local/worker/wrangler.jsonc
```

Your code stays the same: `using repo = await env.ARTIFACTS.get("app")`, `repo.readFile(...)`, and so
on. Git from inside a Worker works too: the docs' [isomorphic-git example](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)
pushes to the emulator over the Worker's `fetch`, with no compatibility flags. Errors arrive as `ArtifactsError` with the real `code` and `numericCode`, and Blobs keep their
MIME type. Wrangler warns that `artifacts` is not set on `env.local`; that is intended.
[examples/hello](examples/hello) is a working app, and `npm run e2e` drives it end to end with
`git push`.

## Use it from Node or tests

```ts
import { startServer, handleBinding, createArtifactsBinding } from "artifacts-local";

const srv = await startServer({ dataDir: "/tmp/art" }, [handleBinding]);
const artifacts = createArtifactsBinding({ url: srv.url, namespace: "default" }); // typed like env.ARTIFACTS
const { remote, token } = await artifacts.create("app");
// git -c http.extraHeader="Authorization: Bearer $token" push $remote main
```

## Events

Subscribe a queue to events when you start the emulator, as an event subscription does in
production:

```sh
# artifacts: repo.created, .forked, .deleted, .imported for every repo
# artifacts.repo: pushed, cloned, fetched, token.* for one repo
npx artifacts-local serve \
  --subscribe artifacts-events:artifacts \
  --subscribe artifacts-events:artifacts.repo:default/app
```

Under `wrangler dev` the shim moves those events into a local Queue named `artifacts-events`, so
your Worker's `queue()` handler receives them unchanged. Add the consumer to your local
environment:

```jsonc
"env": { "local": { "queues": { "consumers": [{ "queue": "artifacts-events" }] } } }
```

Delivery starts with the first `env.ARTIFACTS` call. Elsewhere, read a queue's feed directly
(`GET /__local/queues/<queue>/messages?after=<n>`) or manage subscriptions over HTTP
(`/__local/queues/<queue>/subscriptions`). `--webhook <url>` still POSTs every event.

## Metrics and cost

The emulator records each operation the way Cloudflare's `artifactsEventsAdaptiveGroups` metrics
dataset does (event types as the live service records them, which is more than the docs list), and
estimates what it would cost:

```sh
curl -s 'http://127.0.0.1:8788/__local/metrics?groupBy=repository,eventType&eventKind=action' | jq
curl -s 'http://127.0.0.1:8788/__local/usage' | jq '.recorded, .estimate'
# Project a volume: 1,000 agents × 50 operations a day for 30 days, 20 GB stored
curl -s 'http://127.0.0.1:8788/__local/usage?operations=1500000&storageGb=20' | jq .estimate.usd
```

`/__local/metrics` takes the dataset's filters (`eventKind`, `eventType`, `repository`,
`repositoryNamespace`, `repositoryName`, `datetime_geq`, `datetime_leq`), `groupBy` over its
dimensions, and `limit`. Prices are Workers Paid list prices: 10,000 operations and 1 GB included
a month, then $0.15 per 1,000 operations and $0.50 per GB-month. Which operations Cloudflare bills
is not documented beyond create, push, pull, and clone, so the estimate counts all of them.

## REST and Git

```sh
API=http://127.0.0.1:8788/client/v4/accounts/any/artifacts/namespaces/default
curl -s -H 'Authorization: Bearer any' -X POST $API/repos -d '{"name":"app"}' | jq .result
git -c http.extraHeader="Authorization: Bearer $TOKEN" push "$REMOTE" main
curl -s http://127.0.0.1:8788/__local/events | jq '.[].type'   # emulator-only: event history
```

Any bearer token works on REST unless you pass `--api-token`. Any account ID works unless you pass
`--account-id`.

## Tests

```sh
npm test               # unit + integration, including a run inside workerd (Miniflare)
npm run test:coverage  # thresholds: 90% lines/functions/statements, 85% branches
npm run build          # dist/ with tsdown (Rolldown), checked by publint
npm run lint           # oxlint
npm run format         # oxfmt
npm run check          # typecheck, lint, format, and dist/ up to date: what CI checks besides tests
npm run test:contract  # behaviour the emulator must share with the real service
npm run e2e            # real `wrangler dev` + example app + git push
```

### Checking parity with the real service

The live service, not the docs, is the reference: it already differs from them in places (token
format, fork options, `read_only`; see SPEC.md). Parity is checked in three layers:

1. **Recorded fixture, every CI run, no credentials.** `test/fixtures/live.json` is a recording
   of a fixed scenario (`test/record/scenario.ts`: every REST route plus git push, clone, partial
   and shallow clone, and auth failures) against the live service, with ids, hashes, times, and
   secrets normalised. `test/fixtures.test.ts` replays the scenario against the emulator and
   compares each step: status, content type, body, error codes and messages, git exit codes and
   `remote:` lines. Set `ARTIFACTS_OFFLINE=1` to skip the steps that import from GitHub.
2. **Live contract run, on demand.** `test/contract` makes assertions against the real service:
   ```sh
   ARTIFACTS_LIVE=1 CLOUDFLARE_ACCOUNT_ID=... ARTIFACTS_API_TOKEN=... npm run test:live
   ```
3. **Re-recording when the service changes:**
   ```sh
   CLOUDFLARE_ACCOUNT_ID=... npm run record -- --use-cf-login   # or ARTIFACTS_API_TOKEN=...
   ```
   Review the fixture diff, fix the emulator until `npm test` passes, and update SPEC.md.

A token with **Account → Artifacts → Edit** works for both; so does the OAuth token from
`cf auth login` (checked 2026-10-08), which expires after an hour. Live runs use a throwaway
namespace and delete it afterwards. A full recording is about 100 operations; Artifacts includes
10,000 a month before billing.

## Testing failure handling

Limits and faults are opt-in, to exercise retries and degradation before production does:

```sh
npx artifacts-local serve --rate-limit 20/10          # 429 + Retry-After past 20 requests per 10 s
npx artifacts-local serve --rate-limit default        # the documented 2000 per 10 s
npx artifacts-local serve --fail-rate 0.1 --fault-seed 1 --latency 200
npx artifacts-local serve --max-repo-bytes 1048576    # refuse pushes past 1 MB (default 1 GB)
```

Rate limits count HTTP requests per namespace (REST and the binding) and per repo (git); a single
`git fetch` is several requests. How the live service answers these conditions is not documented,
so the response bodies are guesses (see SPEC.md).

## Not emulated

The 1 TB account cap, jurisdictions beyond storing the field, Workers Builds integration, and
GraphQL itself (`/__local/metrics` serves the same groups over plain HTTP). `import` reaches only
public remotes (it shells out to `git clone`).
