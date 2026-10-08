import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "rolldown";
import { handleBinding } from "../src/binding-rpc.ts";
import { git, readFileAt } from "../src/git.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { tempDir } from "./helpers.ts";

// The Artifacts isomorphic-git example running inside workerd: env.ARTIFACTS is the shim, and
// isomorphic-git pushes to the emulator over the Worker's fetch.

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let mf: Miniflare;

async function bundle(input: string, platform: "browser" | "neutral"): Promise<string> {
  const out = await build({
    input,
    platform,
    external: ["cloudflare:workers"],
    write: false,
    output: { format: "esm" },
  });
  return out.output[0].code;
}

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data") }, [handleBinding]);
  const [app, shim] = await Promise.all([
    bundle(join(import.meta.dirname, "workers/isomorphic-git-app.ts"), "browser"),
    bundle(join(import.meta.dirname, "../worker/shim.ts"), "neutral"),
  ]);
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: [{ type: "ESModule", path: "app.js", contents: app }],
          compatibilityDate: "2026-09-01",
          serviceBindings: { ARTIFACTS: { name: "shim", entrypoint: "ArtifactsLocal" } },
        },
        {
          name: "shim",
          modules: [{ type: "ESModule", path: "shim.js", contents: shim }],
          compatibilityDate: "2026-09-01",
          bindings: { ARTIFACTS_LOCAL_URL: srv.url },
        },
      ],
    }),
  );
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  await srv?.close();
  await tmp?.cleanup();
});

describe("isomorphic-git inside workerd", () => {
  it("creates a repo, commits in memory, and pushes it, as the Artifacts example does", async () => {
    const res = await mf.dispatchFetch("http://app/?repo=worker-demo");
    const body = (await res.json()) as {
      commit?: string;
      ok?: boolean;
      error?: string;
      refs?: Record<string, { ok: boolean }>;
    };
    expect(res.status, body.error).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.refs?.["refs/heads/main"]?.ok).toBe(true);

    const gitDir = srv.store.gitDir("default", "worker-demo");
    const head = (await git(["--git-dir", gitDir, "rev-parse", "main"])).stdout.toString().trim();
    expect(head).toBe(body.commit);
    expect((await readFileAt(gitDir, "main", "src/index.ts"))!.toString()).toBe(
      'export const message = "hello from Artifacts";\n',
    );
    expect(srv.store.events.history.map((e) => e.type)).toContain("cf.artifacts.repo.pushed");
  });
});
