#!/usr/bin/env node
import { a as handleBinding, t as startServer } from "./server-DuCPDqG7.js";
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
  --async-delay <ms>      Hold forks/imports in progress this long
  --allow-insecure-import Allow importing from file paths and http:// URLs
  --track-push-times      Update last_push_at on push (the live service does not)
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
		"async-delay": { type: "string" },
		"allow-insecure-import": {
			type: "boolean",
			default: false
		},
		"track-push-times": {
			type: "boolean",
			default: false
		},
		help: {
			type: "boolean",
			short: "h",
			default: false
		}
	}
});
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
	asyncDelayMs: values["async-delay"] ? Number(values["async-delay"]) : void 0,
	allowInsecureImport: values["allow-insecure-import"],
	trackPushTimes: values["track-push-times"]
}, [handleBinding]);
process.stdout.write(`artifacts-local listening on ${server.url}\n`);
process.stdout.write(`  REST: ${server.url}/client/v4/accounts/<account_id>/artifacts\n`);
process.stdout.write(`  Git:  ${server.url}/git/<namespace>/<repo>.git\n`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void server.close().then(() => process.exit(0)));
//#endregion
export {};
