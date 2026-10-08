#!/usr/bin/env node
// Build dist/: bundled ESM for plain `node` (Node will not strip types under node_modules, #1)
// plus .d.ts declarations. dist/ is committed so `github:` installs work without a build step;
// CI checks it is up to date.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts", "src/cli.ts", "src/client.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // Chunks stay at the top of dist/: store.ts finds hooks/ as "../hooks" from its own file,
  // which holds for src/ and dist/ but not for dist/chunks/.
  chunkNames: "[name]-[hash]",
  legalComments: "none",
  logLevel: "warning",
});

execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });

// tsc keeps the sources' `.ts` specifiers in declarations; point them at the emitted .d.ts files.
for (const f of readdirSync(dist)) {
  if (!f.endsWith(".d.ts")) continue;
  const p = join(dist, f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}

process.stdout.write(`built ${dist}\n`);
