#!/usr/bin/env node
import { i as seededRandom, r as parseRateLimit, s as handleBinding, t as startServer } from "./server-CWRaGbk8.js";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
//#region src/cli.ts
const USAGE = `artifacts-local serve [options]

Local emulator for Cloudflare Artifacts.

Options:
  --port <n>              Port to listen on (default 8788)
  --host <addr>           Address to bind (default 127.0.0.1)
  --data-dir <path>       Where repos are stored (default ./.artifacts-local)
  --account-id <id>       Account ID to require in REST paths (default: accept any)
  --api-token <token>     Bearer token to require on REST calls (default: accept any)
  --public-url <url>      Base for returned remote URLs (default: the listen address)
  --webhook <url>         POST every event to this URL
  --subscribe <spec>      Subscribe a queue to events (repeatable). <spec> is
                          <queue>:artifacts or <queue>:artifacts.repo:<namespace>/<repo>
  --async-delay <ms>      Hold forks/imports in progress this long
  --allow-insecure-import Allow importing from file paths and http:// URLs
  --track-push-times      Update last_push_at on push (the live service does not)
  --max-repo-bytes <n>    Largest repository a push may grow to (default 1 GB, as documented)
  --rate-limit <spec>     Throttle per namespace and per repo: <requests>/<seconds>, or
                          default for the documented 2000/10
  --fail-rate <0-1>       Answer this share of Artifacts requests with a 500
  --latency <ms>          Add this much latency to Artifacts requests
  --fault-seed <n>        Seed for --fail-rate, to fail the same requests every run
`;
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		port: {
			type: "string",
			default: "8788"
		},
		host: {
			type: "string",
			default: "127.0.0.1"
		},
		"data-dir": {
			type: "string",
			default: ".artifacts-local"
		},
		"account-id": { type: "string" },
		"api-token": { type: "string" },
		"public-url": { type: "string" },
		webhook: { type: "string" },
		subscribe: {
			type: "string",
			multiple: true
		},
		"async-delay": { type: "string" },
		"allow-insecure-import": {
			type: "boolean",
			default: false
		},
		"track-push-times": {
			type: "boolean",
			default: false
		},
		"max-repo-bytes": { type: "string" },
		"rate-limit": { type: "string" },
		"fail-rate": { type: "string" },
		latency: { type: "string" },
		"fault-seed": { type: "string" },
		help: {
			type: "boolean",
			short: "h",
			default: false
		}
	}
});
function parseSubscribe(spec) {
	const [queue, type, target] = spec.split(":");
	if (type === "artifacts" && queue) return {
		queue,
		source: { type }
	};
	const [namespace, repo_name] = (target ?? "").split("/");
	if (type === "artifacts.repo" && queue && namespace && repo_name) return {
		queue,
		source: {
			type,
			namespace,
			repo_name
		}
	};
	process.stderr.write(`invalid --subscribe ${JSON.stringify(spec)}\n${USAGE}`);
	process.exit(1);
}
if (values.help || positionals[0] !== "serve") {
	process.stdout.write(USAGE);
	process.exit(values.help ? 0 : 1);
}
const server = await startServer({
	dataDir: resolve(values["data-dir"]),
	port: Number(values.port),
	host: values.host,
	accountId: values["account-id"],
	apiToken: values["api-token"],
	publicUrl: values["public-url"],
	webhookUrl: values.webhook,
	subscriptions: (values.subscribe ?? []).map(parseSubscribe),
	asyncDelayMs: values["async-delay"] ? Number(values["async-delay"]) : void 0,
	allowInsecureImport: values["allow-insecure-import"],
	trackPushTimes: values["track-push-times"],
	maxRepoBytes: values["max-repo-bytes"] ? Number(values["max-repo-bytes"]) : void 0,
	rateLimit: values["rate-limit"] !== void 0 ? parseRateLimit(values["rate-limit"]) : void 0,
	faults: {
		failRate: values["fail-rate"] ? Number(values["fail-rate"]) : void 0,
		latencyMs: values.latency ? Number(values.latency) : void 0,
		random: values["fault-seed"] ? seededRandom(Number(values["fault-seed"])) : void 0
	}
}, [handleBinding]);
process.stdout.write(`artifacts-local listening on ${server.url}\n`);
process.stdout.write(`  REST: ${server.url}/client/v4/accounts/<account_id>/artifacts\n`);
process.stdout.write(`  Git:  ${server.url}/git/<namespace>/<repo>.git\n`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void server.close().then(() => process.exit(0)));
//#endregion
export {};
