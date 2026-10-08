#!/usr/bin/env node
// Record the live service's behaviour as a fixture.
//
//   CLOUDFLARE_ACCOUNT_ID=... ARTIFACTS_API_TOKEN=... npm run record
//   CLOUDFLARE_ACCOUNT_ID=... npm run record -- --use-cf-login   # reuse `cf auth login`
//
// Creates a throwaway namespace, runs test/record/scenario.ts against it, deletes it, and
// writes the normalised exchanges to test/fixtures/live.json.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalize } from "../test/record/normalize.ts";
import { runScenario } from "../test/record/scenario.ts";

function cfLoginToken(): string {
  const candidates = [
    join(homedir(), "Library/Preferences/cloudflare/config/default.json"),
    join(homedir(), ".config/cloudflare/config/default.json"),
  ];
  for (const p of candidates) {
    try {
      const c = JSON.parse(readFileSync(p, "utf8")) as { oauth_token?: string; expiration_time?: string };
      if (c.oauth_token) {
        if (c.expiration_time && Date.parse(c.expiration_time) < Date.now()) {
          throw new Error(`cf login token in ${p} expired at ${c.expiration_time}; run any cf command to refresh it`);
        }
        return c.oauth_token;
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("cf login")) throw e;
    }
  }
  throw new Error("no cf login found; run `cf auth login`");
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) throw new Error("set CLOUDFLARE_ACCOUNT_ID");
const token = process.argv.includes("--use-cf-login") ? cfLoginToken() : process.env.ARTIFACTS_API_TOKEN;
if (!token) throw new Error("set ARTIFACTS_API_TOKEN or pass --use-cf-login");

const namespace = `al-record-${Date.now().toString(36)}`;
const exchanges = await runScenario({
  account: `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts`,
  token,
  namespace,
});
const out = join(import.meta.dirname, "../test/fixtures/live.json");
const recorded = {
  recordedAt: new Date().toISOString().slice(0, 10),
  exchanges: normalize(exchanges, namespace, [account, token]),
};
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`recorded ${exchanges.length} exchanges from ${namespace} into ${out}\n`);
