import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { handleBinding } from "../src/binding-rpc.ts";
import { createArtifactsBinding } from "../src/client.ts";
import { git as gitCli } from "../src/git.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import type { Artifacts } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

// The flow from the Artifacts isomorphic-git example: create a repo through the binding, commit
// with isomorphic-git, and push with the token secret as the Basic password. Then read it back,
// with isomorphic-git and with the git CLI.

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let artifacts: Artifacts;
const author = {
  name: "Artifacts example",
  email: "artifacts@example.com",
  timestamp: 1_760_000_000,
  timezoneOffset: 0,
};
const onAuthFor = (token: string) => () => ({ username: "x", password: token.split("?expires=")[0]! });

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data") }, [handleBinding]);
  artifacts = createArtifactsBinding({ url: srv.url, namespace: "default" });
});

afterAll(async () => {
  await srv.close();
  await tmp.cleanup();
});

async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    fs.mkdirSync(join(dir, path, ".."), { recursive: true });
    fs.writeFileSync(join(dir, path), content);
    await git.add({ fs, dir, filepath: path });
  }
  return git.commit({ fs, dir, message, author });
}

describe("isomorphic-git against the emulator", () => {
  it("pushes a new repo, as in the Artifacts example", async () => {
    const created = await artifacts.create("iso-demo");
    const dir = join(tmp.path, "iso-demo");
    await git.init({ fs, dir, defaultBranch: "main" });
    const commit = await commitFiles(
      dir,
      { "README.md": "# Artifacts repo created from a Worker\n", "src/index.ts": 'export const message = "hello";\n' },
      "Create starter files",
    );
    const push = await git.push({ fs, http, dir, url: created.remote, ref: "main", onAuth: onAuthFor(created.token) });
    expect(push.ok).toBe(true);
    expect(push.refs["refs/heads/main"]).toMatchObject({ ok: true });

    using repo = await artifacts.get("iso-demo");
    const [head] = await repo.log({ ref: "main" });
    expect(head).toMatchObject({ hash: commit, message: "Create starter files" });
    expect(await (await repo.readFile({ ref: "main", path: "src/index.ts" }))!.text()).toContain("hello");

    // The git CLI sees the same history.
    const ls = await gitCli([
      "-c",
      `http.extraHeader=Authorization: Bearer ${created.token}`,
      "ls-remote",
      created.remote,
    ]);
    expect(ls.stdout.toString()).toContain(`${commit}\trefs/heads/main`);
  });

  it("clones, fetches, and pushes again", async () => {
    const created = await artifacts.create("iso-roundtrip");
    const first = join(tmp.path, "iso-first");
    await git.init({ fs, dir: first, defaultBranch: "main" });
    await commitFiles(first, { "a.txt": "a\n" }, "one");
    await git.push({ fs, http, dir: first, url: created.remote, ref: "main", onAuth: onAuthFor(created.token) });

    const second = join(tmp.path, "iso-second");
    await git.clone({
      fs,
      http,
      dir: second,
      url: created.remote,
      ref: "main",
      singleBranch: true,
      onAuth: onAuthFor(created.token),
    });
    expect(fs.readFileSync(join(second, "a.txt"), "utf8")).toBe("a\n");

    const two = await commitFiles(first, { "b.txt": "b\n" }, "two");
    await git.push({ fs, http, dir: first, url: created.remote, ref: "main", onAuth: onAuthFor(created.token) });
    const fetched = await git.fetch({
      fs,
      http,
      dir: second,
      url: created.remote,
      ref: "main",
      singleBranch: true,
      onAuth: onAuthFor(created.token),
    });
    expect(fetched.fetchHead).toBe(two);

    await git.merge({ fs, dir: second, ours: "main", theirs: fetched.fetchHead!, fastForwardOnly: true, author });
    await git.checkout({ fs, dir: second, ref: "main" });
    expect(fs.readFileSync(join(second, "b.txt"), "utf8")).toBe("b\n");

    const three = await commitFiles(second, { "c.txt": "c\n" }, "three");
    const pushed = await git.push({
      fs,
      http,
      dir: second,
      url: created.remote,
      ref: "main",
      onAuth: onAuthFor(created.token),
    });
    expect(pushed.ok).toBe(true);
    using repo = await artifacts.get("iso-roundtrip");
    expect((await repo.log()).map((c) => c.hash)).toEqual([three, two, expect.any(String)]);
  });

  it("is refused a push with a read token and asked for credentials without one", async () => {
    const created = await artifacts.create("iso-denied");
    using repo = await artifacts.get("iso-denied");
    const read = await repo.createToken("read", 600);
    const dir = join(tmp.path, "iso-denied");
    await git.init({ fs, dir, defaultBranch: "main" });
    await commitFiles(dir, { "x.txt": "x" }, "x");

    const denied = await git
      .push({ fs, http, dir, url: created.remote, ref: "main", onAuth: onAuthFor(read.plaintext) })
      .then(
        () => null,
        (e: { code?: string; data?: { statusCode?: number } }) => e,
      );
    expect(denied).toMatchObject({ code: "HttpError", data: { statusCode: 403 } });

    let asked = false;
    const anonymous = await git
      .push({
        fs,
        http,
        dir,
        url: created.remote,
        ref: "main",
        onAuth: () => {
          asked = true;
          return { cancel: true };
        },
      })
      .then(
        () => null,
        (e: { code?: string }) => e,
      );
    expect(asked).toBe(true);
    expect(anonymous).toMatchObject({ code: "UserCanceledError" });
  });
});
