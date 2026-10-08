# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local emulator for Cloudflare Artifacts (Git storage you create and fork programmatically). It
reproduces all three surfaces — the Workers binding (`env.ARTIFACTS`), the v4 REST API, and Git smart
HTTP — backed by bare Git repositories on disk. Node 24+, `git` with `git http-backend`, **no runtime
dependencies**.

**The live service is the reference, not the docs.** Where they disagree, the emulator follows live.
`SPEC.md` lists every emulated rule with its source and status (`doc` / `live <date>` / `guess`);
update it whenever behaviour changes. Do not add Git-platform features Artifacts lacks (branch APIs,
merges, write protection on `read_only`, …) — the README's "What Artifacts does not provide" table is
deliberate: code that works here must work in production.

## Commands

```sh
npm start                      # run src/cli.ts directly (Node 24 strips types); serves :8788, data in ./.artifacts-local
npm test                       # vitest: unit + integration + fixture replay + a run inside workerd (Miniflare)
npx vitest run test/git.test.ts            # single file
npx vitest run test/git.test.ts -t "name"  # single test
npm run test:coverage          # thresholds 90% lines/functions/statements, 85% branches (src/cli.ts excluded)
npm run check                  # typecheck + oxlint --deny-warnings + oxfmt --check + build + dist/ diff — CI minus tests
npm run build                  # tsdown → dist/ (publint runs on every build)
npm run format                 # oxfmt, 120 columns; *.md, test/fixtures/, dist/, package*.json are ignored
npm run e2e                    # real `wrangler dev` + examples/hello + git push (needs ports 8788, 8791 free)
ARTIFACTS_OFFLINE=1 npm test   # skip fixture steps that import from GitHub
```

Live-service commands (need `CLOUDFLARE_ACCOUNT_ID` plus `ARTIFACTS_API_TOKEN` or `--use-cf-login`):
`npm run test:live` (contract tests against the real service, `ARTIFACTS_LIVE=1`) and
`npm run record` (re-record `test/fixtures/live.json`; review the diff, fix the emulator until
`npm test` passes, update SPEC.md).

## dist/ is committed

`dist/` is committed so `github:` installs need no build. **After any change to `src/`, run
`npm run build` and commit `dist/`** — CI and `npm run check` fail on a stale `dist/`. Build-only
commits ("Rebuild dist/ …") are normal here.

## Architecture

One Node HTTP server (`src/server.ts` `startServer`) tries handlers in order, each returning `true`
if it took the request: `handleLocal` (`/__local/health`, `/__local/events` — emulator-only), then
`handleRest` (`src/rest.ts`, `/client/v4/accounts/:id/artifacts/...`), then `handleGit`
(`src/git-http.ts`, `/git/<ns>/<repo>.git/...`), then any extra handlers — notably `handleBinding`
(`src/binding-rpc.ts`). All of them operate on a single `Store`.

- **`src/store.ts`** — the model. Namespaces and repos as directories under `dataDir`; each repo is a
  bare `<name>.git` holding `artifacts-meta.json` and `artifacts-tokens.json` (atomic tmp+rename
  writes). Handles async fork/import states (`forking`/`importing`, held for `asyncDelayMs`),
  pagination cursors, and emits events on its `EventBus`.
- **`src/git.ts`** — spawns `git` with `ISOLATED_GIT_ENV` (no system/global config) and parses
  commits/trees/blobs for the read APIs. **`src/git-http.ts`** fronts `git http-backend` with repo-token
  auth (Bearer or Basic, read/write scope), forces receive-pack to protocol v0/v1, installs
  `hooks/pre-receive` (the 32 MB per-file limit, via `ARTIFACTS_MAX_BLOB_BYTES`), and emits
  `cf.artifacts.repo.pushed` after a push.
- **`src/store.ts` `HOOKS_DIR`** resolves `../hooks` relative to its own file, which is why
  `tsdown.config.ts` keeps all chunks flat at the top of `dist/`.
- **Binding emulation is a two-hop RPC**: `src/client.ts` `createArtifactsBinding()` (uses only
  fetch/Blob/atob so it runs in workerd and Node) POSTs one request per binding call to
  `handleBinding`, which answers with exactly the binding's shapes (camelCase) and serialises
  `ArtifactsError { code, numericCode }` and Blobs (base64 + MIME type). `worker/shim.ts` wraps the
  client in a `WorkerEntrypoint`/`RpcTarget` so a Worker under `wrangler dev` can bind to it as a
  service (`worker/wrangler.jsonc`).
- **REST vs binding shapes differ on purpose**: REST control-plane objects are snake_case in the v4
  envelope; the binding is camelCase. Many quirks in `rest.ts` are commented as "live" — preserve them.
- `src/errors.ts` maps error codes to numeric codes and HTTP statuses; `src/names.ts` validates names;
  `src/tokens.ts` handles token format/TTL/scope; `src/types.ts` mirrors `@cloudflare/workers-types`.
- Public exports: `src/index.ts` (package root) and `src/client.ts` (`artifacts-local/client`);
  `src/cli.ts` is the `artifacts-local` bin.

## Tests

- `test/helpers.ts`: `tempDir()` and `WorkTree` (deterministic author/committer and strictly increasing
  commit dates — use it so hashes are stable).
- `test/fixtures.test.ts` replays `test/record/scenario.ts` against the emulator and compares each step
  (status, content type, body, error codes, git exit codes, `remote:` lines) with the normalised
  recording in `test/fixtures/live.json`. Never hand-edit the fixture; re-record it.
- `test/contract/` runs the same assertions against local (default) or live (`ARTIFACTS_LIVE=1`) via
  `openTarget()` in `target.ts`.
- `test/workerd.test.ts` bundles `worker/shim.ts` with Rolldown and runs it in Miniflare.

## Conventions

- TypeScript with `erasableSyntaxOnly` and `allowImportingTsExtensions`: import with `.ts` extensions,
  no enums/namespaces/parameter properties (Node runs the sources by stripping types).
- oxlint denies warnings; `no-await-in-loop` is intentionally off (sequential git/token operations).
- CHANGELOG.md follows Keep a Changelog; add entries under `[Unreleased]`.
