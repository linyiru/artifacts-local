# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
