import { join } from "node:path";
import { type RunningServer, startServer } from "../../src/server.ts";
import { tempDir } from "../helpers.ts";

// Where contract tests send requests: the local emulator (default) or the real service.
//
//   ARTIFACTS_LIVE=1 CLOUDFLARE_ACCOUNT_ID=... ARTIFACTS_API_TOKEN=... npm run test:contract
//
// The token needs Account > Artifacts > Edit. Live runs use a fresh namespace per run and
// delete every repo they create.

export interface Target {
  name: "local" | "live";
  /** .../accounts/<id>/artifacts/namespaces/<ns> */
  base: string;
  namespace: string;
  headers: Record<string, string>;
  close(): Promise<void>;
}

export const LIVE = process.env.ARTIFACTS_LIVE === "1";

export async function openTarget(): Promise<Target> {
  const ns = `al-contract-${Date.now().toString(36)}`;
  if (LIVE) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.ARTIFACTS_API_TOKEN;
    if (!account || !token) throw new Error("ARTIFACTS_LIVE=1 needs CLOUDFLARE_ACCOUNT_ID and ARTIFACTS_API_TOKEN");
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/${ns}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    return {
      name: "live",
      base,
      namespace: ns,
      headers,
      async close() {
        const list = await fetch(`${base}/repos?limit=200`, { headers });
        const body = (await list.json()) as { result?: { name: string }[] };
        for (const r of body.result ?? []) {
          await fetch(`${base}/repos/${r.name}`, { method: "DELETE", headers });
        }
      },
    };
  }
  const tmp = await tempDir();
  const srv: RunningServer = await startServer({ dataDir: join(tmp.path, "data") });
  return {
    name: "local",
    base: `${srv.url}/client/v4/accounts/contract/artifacts/namespaces/${ns}`,
    namespace: ns,
    headers: { authorization: "Bearer contract", "content-type": "application/json" },
    async close() {
      await srv.close();
      await tmp.cleanup();
    },
  };
}
