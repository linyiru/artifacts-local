import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "./helpers.ts";

// Installs the package the way a consumer does (from a packed tarball into node_modules) and runs
// it with plain `node`, which refuses to strip TypeScript under node_modules (#1).

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

let tmp: Awaited<ReturnType<typeof tempDir>>;
let app: string;
let pkg: string;

beforeAll(async () => {
  tmp = await tempDir("artifacts-pkg-");
  const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", tmp.path], { cwd: ROOT });
  const tarball = join(tmp.path, (JSON.parse(stdout) as { filename: string }[])[0]!.filename);
  app = join(tmp.path, "app");
  await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: app });
  pkg = join(app, "node_modules", "artifacts-local");
}, 120_000);

afterAll(() => tmp?.cleanup());

describe("installed package", () => {
  it("runs the CLI with plain node, directly and through node_modules/.bin", async () => {
    const direct = await run(process.execPath, [join(pkg, "dist/cli.js"), "--help"], { cwd: app });
    expect(direct.stdout).toContain("artifacts-local serve [options]");
    const bin = await run(join(app, "node_modules/.bin/artifacts-local"), ["--help"], { cwd: app });
    expect(bin.stdout).toContain("artifacts-local serve [options]");
  });

  it("serves REST from the installed CLI", async () => {
    const child = spawn(process.execPath, [join(pkg, "dist/cli.js"), "serve", "--port", "0", "--data-dir", join(tmp.path, "cli-data")], {
      cwd: app,
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d) => {
          out += d;
          const m = /listening on (http:\/\/\S+)/.exec(out);
          if (m) resolve(m[1]!);
        });
        child.on("exit", (code) => reject(new Error(`CLI exited with ${code}`)));
      });
      const res = await fetch(`${url}/client/v4/accounts/a/artifacts/namespaces/default/repos`, {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ name: "from-cli" }),
      });
      expect(res.status).toBe(201);
    } finally {
      child.kill();
    }
  });

  it("imports the public API by package name, and its hooks still apply from node_modules", async () => {
    const script = join(app, "consumer.mjs");
    await writeFile(
      script,
      `
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { startServer, handleBinding, createArtifactsBinding, ArtifactsError } from "artifacts-local";
import { createArtifactsBinding as fromClient } from "artifacts-local/client";

// Async git on purpose: the server runs in this process and must keep answering.
const git = (args, env) => promisify(execFile)("git", args, { env });
const dir = mkdtempSync(join(${JSON.stringify(tmp.path)}, "consumer-"));
const srv = await startServer({ dataDir: join(dir, "data"), maxBlobBytes: 16 }, [handleBinding]);
const artifacts = createArtifactsBinding({ url: srv.url, namespace: "default" });
const { remote, token } = await artifacts.create("app");
let missing = "";
try { await artifacts.get("nope"); } catch (e) { missing = e instanceof ArtifactsError ? e.code : String(e); }

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" };
const w = join(dir, "w");
await git(["init", "-q", "-b", "main", w], env);
writeFileSync(join(w, "big.txt"), "x".repeat(64));
await git(["-C", w, "add", "-A"], env);
await git(["-C", w, "commit", "-qm", "big"], env);
let push = "accepted";
try {
  await git(["-C", w, "-c", "http.extraHeader=Authorization: Bearer " + token, "push", "-q", remote, "main"], env);
} catch (e) { push = String(e.stderr); }
await srv.close();
console.log(JSON.stringify({ missing, sameClient: typeof fromClient === "function", push }));
`,
    );
    const { stdout } = await run(process.execPath, [script], { cwd: app });
    const result = JSON.parse(stdout) as { missing: string; sameClient: boolean; push: string };
    expect(result.missing).toBe("NOT_FOUND");
    expect(result.sameClient).toBe(true);
    // The size limit is enforced by hooks/pre-receive, located relative to the bundled code.
    expect(result.push).toContain("big.txt (64 bytes) exceeds the Artifacts limit of 16 bytes per file");
  });

  it("type-checks a TypeScript consumer against the shipped declarations", async () => {
    await writeFile(
      join(app, "consumer.ts"),
      `import { startServer, createArtifactsBinding, type Artifacts, type ArtifactsRepoInfo } from "artifacts-local";
const srv = await startServer({ dataDir: "/tmp/x" });
const a: Artifacts = createArtifactsBinding({ url: srv.url, namespace: "default" });
const info: Promise<ArtifactsRepoInfo> = (await a.get("x")).info();
void info;
`,
    );
    await writeFile(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "es2024", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")] },
        files: ["consumer.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/.bin/tsc");
    const r = await run(tsc, ["-p", app], { cwd: app }).catch((e: { stdout: string }) => e);
    expect("stdout" in r ? r.stdout : "").toBe("");
  });

  it("lets a bundler build the wrangler shim from node_modules, as wrangler does", async () => {
    const { build } = await import("esbuild");
    const out = await build({
      entryPoints: [join(pkg, "worker/shim.ts")],
      bundle: true,
      format: "esm",
      platform: "neutral",
      external: ["cloudflare:workers"],
      write: false,
      logLevel: "silent",
    });
    const code = out.outputFiles[0]!.text;
    expect(code).toMatch(/ArtifactsLocal = class extends WorkerEntrypoint|class ArtifactsLocal extends WorkerEntrypoint/);
    expect(code).toContain("/__local/binding/");
  });

  it("ships runtime files only", async () => {
    const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT });
    const files = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    expect(files).toContain("dist/cli.js");
    expect(files).toContain("hooks/pre-receive");
    expect(files).toContain("worker/shim.ts");
    expect(files.filter((f) => /^(test|\.github|examples|scripts)\//.test(f))).toEqual([]);
  });
});
