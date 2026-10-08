import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  countObjects,
  git,
  gitOk,
  log,
  parseCommit,
  readBlob,
  readCommit,
  readFileAt,
  readObjects,
  readTree,
  resolveCommit,
  sniffContentType,
} from "../src/git.ts";
import { WorkTree, bareFrom, tempDir } from "./helpers.ts";

let tmp: Awaited<ReturnType<typeof tempDir>>;
let bare: string;
let c1: string, c2: string, side: string, merge: string;

beforeAll(async () => {
  tmp = await tempDir();
  const w = await WorkTree.init(join(tmp.path, "work"));
  c1 = await w.commit("first\n\nbody line\n\n", { "README.md": "# hello\n", "src/a.txt": "a\n" }, { verbatim: true });
  await w.write("bin/run.sh", "#!/bin/sh\necho hi\n", { exec: true });
  await w.symlink("README.md", "link");
  await w.write("img.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  c2 = await w.commit("second");
  await w.run(["checkout", "-q", "-b", "feature"]);
  side = await w.commit("side work", { "src/b.txt": "b\n" });
  await w.run(["checkout", "-q", "main"]);
  await w.commit("main moves", { "src/c.txt": "c\n" });
  await w.run(["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
  merge = await w.head();
  await w.run(["tag", "v1", c2]);
  bare = await bareFrom(w, join(tmp.path, "repo.git"), ["--all"]);
  await w.run(["push", "-q", bare, "--tags"]);
});

afterAll(() => tmp.cleanup());

describe("git runner", () => {
  it("returns exit code and stderr without throwing", async () => {
    const r = await git(["--git-dir", bare, "cat-file", "-t", "deadbeef"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toBe("");
  });

  it("gitOk throws INTERNAL_ERROR on failure", async () => {
    await expect(gitOk(["--git-dir", bare, "rev-parse", "nope-ref"])).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("isolates global config", async () => {
    const out = await gitOk(["config", "--global", "--list"]).catch(() => Buffer.from(""));
    expect(out.toString()).toBe("");
  });
});

describe("readObjects", () => {
  it("reads several objects in one batch and marks missing ones null", async () => {
    const missing = "0".repeat(40);
    const [a, b, c] = await readObjects(bare, [c1, missing, c2]);
    expect(a?.type).toBe("commit");
    expect(b).toBeNull();
    expect(c?.hash).toBe(c2);
    expect(await readObjects(bare, [])).toEqual([]);
  });
});

describe("resolveCommit", () => {
  it("resolves branches, tags, HEAD, and hashes", async () => {
    expect(await resolveCommit(bare, "main")).toBe(merge);
    expect(await resolveCommit(bare, "HEAD")).toBe(merge);
    expect(await resolveCommit(bare, "feature")).toBe(side);
    expect(await resolveCommit(bare, "v1")).toBe(c2);
    expect(await resolveCommit(bare, c1)).toBe(c1);
    expect(await resolveCommit(bare, "missing")).toBeNull();
  });

  it("refuses option-shaped refs", async () => {
    await expect(resolveCommit(bare, "--all")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("readCommit", () => {
  it("decodes metadata and strips exactly one trailing newline", async () => {
    const c = await readCommit(bare, c1);
    expect(c).toMatchObject({
      hash: c1,
      message: "first\n\nbody line\n",
      author: { name: "Ada Author", email: "ada@example.com" },
      committer: { name: "Cy Committer", email: "cy@example.com" },
      parents: [],
    });
    expect(c!.treeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(c!.authoredAt).toBeGreaterThan(1_760_000_000);
    expect(c!.committedAt).toBe(c!.authoredAt);
  });

  it("lists merge parents in git order", async () => {
    const m = await readCommit(bare, merge);
    expect(m!.parents).toHaveLength(2);
    expect(m!.parents[1]).toBe(side);
  });

  it("returns null when missing and throws for non-commits", async () => {
    expect(await readCommit(bare, "f".repeat(40))).toBeNull();
    const tree = (await readCommit(bare, c1))!.treeHash;
    await expect(readCommit(bare, tree)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(readCommit(bare, "XYZ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("skips multi-line headers such as gpgsig", () => {
    const raw = Buffer.from(
      "tree " + "a".repeat(40) + "\n" +
      "author A <a@x> 10 +0000\ncommitter B <b@x> 20 +0000\n" +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n abc\n -----END PGP SIGNATURE-----\n\nmsg\n",
    );
    const c = parseCommit("b".repeat(40), raw);
    expect(c).toMatchObject({ message: "msg", authoredAt: 10, committedAt: 20, parents: [] });
  });

  it("tolerates a commit without a message or a malformed identity", () => {
    const c = parseCommit("b".repeat(40), Buffer.from("tree " + "a".repeat(40) + "\nauthor weird\n"));
    expect(c.message).toBe("");
    expect(c.author).toEqual({ name: "weird", email: "" });
  });
});

describe("readTree", () => {
  it("returns immediate children with canonical modes and types", async () => {
    const tree = (await readCommit(bare, c2))!.treeHash;
    const entries = await readTree(bare, tree);
    const byName = Object.fromEntries(entries!.map((e) => [e.name, e]));
    expect(byName["README.md"]).toMatchObject({ mode: "100644", type: "blob" });
    expect(byName["src"]).toMatchObject({ mode: "40000", type: "tree" });
    expect(byName["bin"]).toMatchObject({ mode: "40000", type: "tree" });
    expect(byName["link"]).toMatchObject({ mode: "120000", type: "symlink" });
    expect(Object.keys(byName)).not.toContain("a.txt");

    const bin = await readTree(bare, byName["bin"]!.hash);
    expect(bin).toEqual([expect.objectContaining({ name: "run.sh", mode: "100755", type: "exec" })]);
  });

  it("returns null when missing and throws for non-trees", async () => {
    expect(await readTree(bare, "e".repeat(40))).toBeNull();
    await expect(readTree(bare, c1)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("readBlob / readFileAt", () => {
  it("reads blobs by hash and returns null for non-blobs", async () => {
    const tree = await readTree(bare, (await readCommit(bare, c1))!.treeHash);
    const readme = tree!.find((e) => e.name === "README.md")!;
    expect((await readBlob(bare, readme.hash))!.toString()).toBe("# hello\n");
    expect(await readBlob(bare, c1)).toBeNull();
    expect(await readBlob(bare, "d".repeat(40))).toBeNull();
  });

  it("resolves files by ref and path", async () => {
    expect((await readFileAt(bare, "main", "src/a.txt"))!.toString()).toBe("a\n");
    expect((await readFileAt(bare, "v1", "README.md"))!.toString()).toBe("# hello\n");
    expect((await readFileAt(bare, "main", "/README.md"))!.toString()).toBe("# hello\n");
    expect(await readFileAt(bare, c1, "src/b.txt")).toBeNull();
    expect(await readFileAt(bare, "main", "src")).toBeNull();
    expect(await readFileAt(bare, "nope", "README.md")).toBeNull();
    expect(await readFileAt(bare, "main", "/")).toBeNull();
  });

  it("rejects empty ref or path", async () => {
    await expect(readFileAt(bare, "", "a")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readFileAt(bare, "main", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("sniffContentType", () => {
  it("distinguishes UTF-8 text from binary", () => {
    expect(sniffContentType(Buffer.from("héllo"))).toBe("text/plain;charset=utf-8");
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x00]))).toBe("application/octet-stream");
    expect(sniffContentType(Buffer.from([0xff, 0xfe, 0x41]))).toBe("application/octet-stream");
    expect(sniffContentType(Buffer.alloc(0))).toBe("text/plain;charset=utf-8");
  });
});

describe("log", () => {
  it("follows first parents newest first from HEAD", async () => {
    const commits = await log(bare);
    expect(commits.map((c) => c.message)).toEqual(["merge feature", "main moves", "second", "first\n\nbody line\n"]);
    expect(commits.map((c) => c.hash)).not.toContain(side);
  });

  it("supports ref, limit, and offset", async () => {
    expect((await log(bare, { ref: "feature" })).map((c) => c.hash)[0]).toBe(side);
    expect((await log(bare, { limit: 2 })).length).toBe(2);
    expect((await log(bare, { limit: 1, offset: 2 }))[0]!.hash).toBe(c2);
    expect(await log(bare, { offset: 99 })).toEqual([]);
    expect((await log(bare, { limit: 5000 })).length).toBe(4);
  });

  it("returns [] for an unresolvable ref and validates numbers", async () => {
    expect(await log(bare, { ref: "nope" })).toEqual([]);
    await expect(log(bare, { limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(log(bare, { offset: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns [] for an empty repository", async () => {
    const empty = join(tmp.path, "empty.git");
    await gitOk(["init", "-q", "--bare", empty]);
    expect(await log(empty)).toEqual([]);
    expect(await countObjects(empty)).toBe(0);
  });

  it("counts objects", async () => {
    expect(await countObjects(bare)).toBeGreaterThan(5);
  });
});

describe("git runner stdin", () => {
  it("tolerates commands that exit without reading a large stdin", async () => {
    const r = await git(["--version"], { input: Buffer.alloc(4 * 1024 * 1024, 0x61) });
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).toMatch(/^git version/);
  });
});
