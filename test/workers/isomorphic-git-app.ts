// The Artifacts isomorphic-git example as a Worker: create a repo through env.ARTIFACTS, commit
// in memory, and push to the repo's remote over fetch.
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { Artifacts } from "../../src/types.ts";
import { MemoryFS } from "./memory-fs.ts";

interface Env {
  ARTIFACTS: Artifacts;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("repo") ?? "worker-demo";
    const created = await env.ARTIFACTS.create(name);
    const tokenSecret = created.token.split("?expires=")[0]!;
    const dir = "/workspace";
    const fs = new MemoryFS();
    await git.init({ fs, dir, defaultBranch: "main" });
    await fs.promises.writeFile(`${dir}/README.md`, "# Artifacts repo created from a Worker\n");
    await fs.promises.writeFile(`${dir}/src/index.ts`, 'export const message = "hello from Artifacts";\n');
    await git.add({ fs, dir, filepath: "README.md" });
    await git.add({ fs, dir, filepath: "src/index.ts" });
    const commit = await git.commit({
      fs,
      dir,
      message: "Create starter files",
      author: { name: "Artifacts example", email: "artifacts@example.com" },
    });
    try {
      const push = await git.push({
        fs,
        http,
        dir,
        url: created.remote,
        ref: "main",
        onAuth: () => ({ username: "x", password: tokenSecret }),
      });
      return Response.json({ repo: created.name, remote: created.remote, commit, ok: push.ok, refs: push.refs });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }, { status: 500 });
    }
  },
};
