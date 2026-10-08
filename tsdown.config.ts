import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/client.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: true,
  // package.json is "type": "module"; emit .js / .d.ts rather than .mjs / .d.mts.
  fixedExtension: false,
  // Chunks must sit at the top of dist/: store.ts finds hooks/ as "../hooks" from its own file,
  // which holds for src/ and dist/ but not for a subdirectory.
  outputOptions: { chunkFileNames: "[name]-[hash].js" },
  publint: true,
});
