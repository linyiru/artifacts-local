# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tests, and a step in the live recording, for fetching one blob on demand
  from a blobless clone, the access pattern ArtifactFS uses.
- The live recording captures git capability advertisements and the refused
  `--atomic` and `-o` pushes.

### Changed

- Git advertises the live service's capabilities instead of git's: no
  `atomic`, push options, `quiet`, or `report-status-v2` on receive-pack, which
  now leads with `HEAD`; no `include-tag`, `thin-pack`, `ofs-delta`,
  `wait-for-done`, or `server-option` on upload-pack. `git push --atomic` and
  `git push -o` now fail, as they do against Cloudflare.

### Fixed

- A recording that failed midway could leave its namespace behind; cleanup
  now retries and reports what it could not remove.

## [0.2.2] - 2026-10-08

Tooling only: the public API, CLI, and emulated behaviour are unchanged.

### Changed

- Build `dist/` with tsdown (Rolldown) instead of a custom esbuild script;
  declarations are bundled, and publint checks the package on every build.
- Tests bundle the wrangler shim with Rolldown; esbuild is no longer a
  dependency.
- Lint with oxlint (`npm run lint`): correctness, suspicious, and perf rules
  as errors.
- Format with oxfmt (`npm run format`, 120 columns); recordings, `dist/`,
  Markdown, and npm-managed files are left as they are.

## [0.2.1] - 2026-10-08

### Added

- A package entry point: `import { startServer, createArtifactsBinding } from
  "artifacts-local"`, and `artifacts-local/client` for the binding client
  alone, with type declarations.

### Changed

- The package ships only what it needs at runtime (`dist`, `src` for the
  wrangler shim, `hooks`, `worker`) instead of the whole repository.

### Fixed

- The CLI runs with plain `node` when installed as a dependency. Node does
  not strip types under `node_modules`, so the `bin` and the package entry
  now point at compiled JavaScript in `dist/` (#1).

## [0.2.0] - 2026-10-08

Matches the live service, checked against it on 2026-10-08. Where the live
service and the docs disagree, the emulator now follows the live service.

### Added

- `--track-push-times` (`trackPushTimes`) to update `last_push_at` on push.
- `npm run record` records a fixed scenario against the live service into
  `test/fixtures/live.json` (ids, hashes, times, and secrets normalised), and
  a test replays it against the emulator step by step.
- README and SPEC describe the live service as the reference, and which
  rules were checked against it.

### Changed

- Issue repo tokens as `art_v2_x_<40 hex>?expires=<n>`, the format the live
  service uses (the docs still say `art_v1_`). Both formats are accepted.
- REST `log` and `commit` return camelCase commit metadata (`treeHash`,
  `authoredAt`, `committedAt`), as the live service does.
- REST create, fork, import, and token creation answer `201 Created`;
  namespace deletion answers `204 No Content`.
- REST errors carry `documentation_url` and, for invalid fields,
  `source.pointer`, with the live service's messages. `REMOTE_AUTH_REQUIRED`
  answers `422`. Token requests are validated before the repo is looked up.
- REST namespaces use the live shape `{namespace, jurisdiction, repo_count,
  created_at, updated_at}`, with `jurisdiction: "unrestricted"` by default.
- REST repo list entries include `status`. List `result_info` is
  cursor-style while more pages follow and offset-style on the last page,
  as the live service returns it.
- Repeating a REST repo delete answers `202` with the deleted repo's id, and
  revoking an already revoked token answers `200`; unknown names and ids
  still answer `404`.
- Forks copy every branch and tag and ignore `default_branch_only`, and no
  longer inherit the source's description, matching the live REST API.
- Imported repos record `source` as `git:<url>.git`, and a URL that is not a
  git remote fails with `INVALID_URL`, as live. Without `branch`, an import
  reports `default_branch: "main"` whatever the remote's default is, as live.
- REST `raw/:ref/:path` takes the first path segment as the ref and spells
  the text type `text/plain; charset=utf-8`, as live.
- Unknown routes under `/artifacts` answer a plain-text `404 Not Found`.
- Git answers an invalid, expired, or revoked token with `403 Invalid or
  expired token` and a read token pushing with `403 Insufficient permissions`;
  only a request without credentials gets `401`. Basic auth accepts an empty
  username.
- Partial clone (`--filter`) works over protocol v2 and is ignored over v0,
  as live; it used to be refused over both.
- `read_only` no longer blocks a write-token push: the live service accepts
  such a push, so the emulator does too. Use read tokens to keep a repo
  unchanged.
- A push no longer updates `last_push_at` or `updated_at`, since the live
  service leaves them unchanged.

## [0.1.0] - 2026-10-08

### Added

- Local emulator for Cloudflare Artifacts, built from the documentation and
  `@cloudflare/workers-types`: REST control plane, Git smart HTTP over
  `git http-backend` with repo-token auth, and a Workers binding (RPC endpoint,
  typed fetch client, and a `WorkerEntrypoint` shim for `wrangler dev`).
- Async fork and import states, token TTL bounds and expiry, the 32 MB
  per-file push limit, and the documented event envelopes with history and
  webhook delivery.
- Contract tests that run against the emulator or the live service, a
  `wrangler dev` end-to-end script, and CI.

[unreleased]: https://github.com/linyiru/artifacts-local/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/linyiru/artifacts-local/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/linyiru/artifacts-local/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/linyiru/artifacts-local/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/linyiru/artifacts-local/releases/tag/v0.1.0
