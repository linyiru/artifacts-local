import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitOk } from "../src/git.ts";

export async function tempDir(prefix = "artifacts-local-"): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

let tick = 0;

/** A working tree with deterministic identities and strictly increasing commit dates. */
export class WorkTree {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  static async init(dir: string, branch = "main"): Promise<WorkTree> {
    await mkdir(dir, { recursive: true });
    await gitOk(["init", "-q", "-b", branch, dir]);
    return new WorkTree(dir);
  }

  env(): Record<string, string> {
    const date = `${1_760_000_000 + ++tick} +0000`;
    return {
      GIT_AUTHOR_NAME: "Ada Author",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Cy Committer",
      GIT_COMMITTER_EMAIL: "cy@example.com",
      GIT_COMMITTER_DATE: date,
    };
  }

  run(args: string[], env: Record<string, string> = {}): Promise<Buffer> {
    return gitOk(["-C", this.dir, ...args], { env: { ...this.env(), ...env } });
  }

  async write(path: string, content: string | Buffer, opts: { exec?: boolean } = {}): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    if (opts.exec) await chmod(full, 0o755);
  }

  async symlink(target: string, path: string): Promise<void> {
    await symlink(target, join(this.dir, path));
  }

  async commit(
    message: string,
    files: Record<string, string | Buffer> = {},
    opts: { verbatim?: boolean } = {},
  ): Promise<string> {
    for (const [p, c] of Object.entries(files)) await this.write(p, c);
    await this.run(["add", "-A"]);
    const cleanup = opts.verbatim ? ["--cleanup=verbatim"] : [];
    await this.run(["commit", "-q", "--allow-empty", ...cleanup, "-m", message]);
    return this.head();
  }

  async head(ref = "HEAD"): Promise<string> {
    return (await this.run(["rev-parse", ref])).toString().trim();
  }
}

/** A bare repo seeded from a work tree push, the on-disk shape the emulator uses. */
export async function bareFrom(work: WorkTree, bareDir: string, refspecs = ["--all"]): Promise<string> {
  await gitOk(["init", "-q", "--bare", "-b", "main", bareDir]);
  await work.run(["push", "-q", bareDir, ...refspecs]);
  return bareDir;
}
