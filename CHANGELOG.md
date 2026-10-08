# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  git remote fails with `INVALID_URL`, as live.

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

[unreleased]: https://github.com/linyiru/artifacts-local/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/linyiru/artifacts-local/releases/tag/v0.1.0
