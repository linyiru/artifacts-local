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
| Git smart HTTP (`…/git/<ns>/<repo>.git`) | `git http-backend` behind repo-token auth: Bearer or Basic, read/write scopes, push over protocol v0/v1 only, no partial clone |

Also emulated: async fork/import states (`forking`, `importing`, `FORK_IN_PROGRESS`), token TTL
bounds and expiry, read-only repos, the 32 MB per-file limit, and the documented event envelopes
(`cf.artifacts.repo.pushed` and friends), which you can read back or have POSTed to a webhook.

[SPEC.md](SPEC.md) lists every emulated rule, its source, and which ones are guesses because the
docs are silent.

## Requirements

Node 24+ (runs the TypeScript sources directly) and `git` with `git http-backend`.

## Run the emulator

```sh
npm install
npm start                      # http://127.0.0.1:8788, data in ./.artifacts-local
node src/cli.ts serve --help   # port, data dir, webhook, --async-delay, --allow-insecure-import, …
```

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
npm start --prefix artifacts-local &
wrangler dev -e local -c wrangler.jsonc -c artifacts-local/worker/wrangler.jsonc
```

Your code stays the same: `using repo = await env.ARTIFACTS.get("app")`, `repo.readFile(...)`, and so
on. Errors arrive as `ArtifactsError` with the real `code` and `numericCode`, and Blobs keep their
MIME type. Wrangler warns that `artifacts` is not set on `env.local`; that is intended.
[examples/hello](examples/hello) is a working app, and `npm run e2e` drives it end to end with
`git push`.

## Use it from Node or tests

```ts
import { startServer } from "artifacts-local/src/server.ts";
import { handleBinding } from "artifacts-local/src/binding-rpc.ts";
import { createArtifactsBinding } from "artifacts-local/src/client.ts";

const srv = await startServer({ dataDir: "/tmp/art" }, [handleBinding]);
const artifacts = createArtifactsBinding({ url: srv.url, namespace: "default" }); // typed like env.ARTIFACTS
const { remote, token } = await artifacts.create("app");
// git -c http.extraHeader="Authorization: Bearer $token" push $remote main
```

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
npm run test:contract  # behaviour the emulator must share with the real service
npm run e2e            # real `wrangler dev` + example app + git push
```

### Checking parity with the real service

The contract suite in `test/contract` runs against either target. Point it at Cloudflare with an
API token that has **Account → Artifacts → Edit** (OAuth logins from `wrangler login` or `cf auth
login` are refused by the REST API):

```sh
ARTIFACTS_LIVE=1 CLOUDFLARE_ACCOUNT_ID=... ARTIFACTS_API_TOKEN=... npm run test:live
```

Each run uses a fresh namespace and deletes the repos it creates. Any failure is a place where the
emulator and the service disagree. Fix the emulator, and move the rule in SPEC.md from "doc" or
"guess" to "live".

## Not emulated

Rate limits, the 1 GB repo / 1 TB account caps, jurisdictions beyond storing the field, Workers
Builds integration, metrics, and the `include-tag` capability. `import` reaches only public
remotes (it shells out to `git clone`).
