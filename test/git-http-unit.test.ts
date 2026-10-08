import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PackDetector, classifyUploadPack, parseGitRoute, presentedToken, pushPayloads } from "../src/git-http.ts";
import { WorkTree, bareFrom, tempDir } from "./helpers.ts";

const q = (s = "") => new URLSearchParams(s);
const H = "a".repeat(40);

describe("parseGitRoute", () => {
  it("recognises the smart HTTP endpoints", () => {
    expect(parseGitRoute("GET", "/git/default/app.git/info/refs", q("service=git-upload-pack"))).toEqual({
      ns: "default",
      repo: "app",
      service: "git-upload-pack",
      path: "/info/refs",
    });
    expect(parseGitRoute("POST", "/git/default/app.git/git-receive-pack", q())?.service).toBe("git-receive-pack");
    expect(parseGitRoute("POST", "/git/default/app.git/git-upload-pack", q())?.service).toBe("git-upload-pack");
  });

  it("rejects dumb HTTP, wrong methods, bad names, and unknown services", () => {
    expect(parseGitRoute("GET", "/git/default/app.git/HEAD", q())).toBeNull();
    expect(parseGitRoute("POST", "/git/default/app.git/info/refs", q("service=git-upload-pack"))).toBeNull();
    expect(parseGitRoute("GET", "/git/default/app.git/git-upload-pack", q())).toBeNull();
    expect(parseGitRoute("GET", "/git/default/app.git/info/refs", q())).toBeNull();
    expect(parseGitRoute("GET", "/git/default/app.git/info/refs", q("service=git-archive"))).toBeNull();
    expect(parseGitRoute("GET", "/git/x/app.git/info/refs", q("service=git-upload-pack"))).toBeNull();
    expect(parseGitRoute("GET", "/git/default/-app.git/info/refs", q("service=git-upload-pack"))).toBeNull();
  });
});

const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("presentedToken", () => {
  const secret = `art_v2_x_${"b".repeat(40)}`;
  it("reads Bearer tokens", () => {
    expect(presentedToken(`Bearer ${secret}?expires=1`)).toBe(`${secret}?expires=1`);
    expect(presentedToken(`bearer ${secret}`)).toBe(secret);
  });

  it("reads Basic auth with any user, even an empty one, and the secret as password", () => {
    expect(presentedToken(basic(`x:${secret}`))).toBe(secret);
    expect(presentedToken(basic(`anyone:${secret}`))).toBe(secret);
    expect(presentedToken(basic(`:${secret}`))).toBe(secret);
    expect(presentedToken(basic("x:"))).toBeNull();
    expect(presentedToken(basic("nocolon"))).toBeNull();
  });

  it("ignores missing or unknown schemes", () => {
    expect(presentedToken(undefined)).toBeNull();
    expect(presentedToken("Bearer")).toBeNull();
    expect(presentedToken(`Token ${secret}`)).toBeNull();
  });
});

describe("classifyUploadPack", () => {
  it("treats wants without haves as a clone", () => {
    expect(classifyUploadPack(Buffer.from(`0032want ${H}\n00000009done\n`), undefined)).toBe("clone");
  });

  it("treats wants with haves as a fetch, with or without done", () => {
    expect(classifyUploadPack(Buffer.from(`0032want ${H}\n00000032have ${H}\n0009done\n`), undefined)).toBe("fetch");
    expect(classifyUploadPack(Buffer.from(`0032want ${H}\n00000032have ${H}\n0000`), undefined)).toBe("fetch");
  });

  it("ignores ls-refs and handles gzip bodies", () => {
    expect(classifyUploadPack(Buffer.from("0014command=ls-refs\n0000"), undefined)).toBe("none");
    expect(classifyUploadPack(gzipSync(Buffer.from(`0032want ${H}\n0009done\n`)), "gzip")).toBe("clone");
    expect(classifyUploadPack(Buffer.from("not gzip"), "gzip")).toBe("none");
  });
});

describe("PackDetector", () => {
  it("finds a sideband PACK header even when split across chunks", () => {
    const d = new PackDetector();
    d.push(Buffer.from("0008NAK\n0031\x01PA"));
    expect(d.found).toBe(false);
    d.push(Buffer.from("CK\x00\x00\x00\x02"));
    expect(d.found).toBe(true);
    d.push(Buffer.from("more"));
    expect(d.found).toBe(true);
  });

  it("ignores responses without a pack", () => {
    const d = new PackDetector();
    d.push(Buffer.from(`0038ACK ${H} common\n0008NAK\n`));
    expect(d.found).toBe(false);
  });
});

describe("pushPayloads", () => {
  it("describes created, updated, and deleted refs", async () => {
    const tmp = await tempDir();
    try {
      const w = await WorkTree.init(join(tmp.path, "w"));
      const c1 = await w.commit("one");
      await w.run(["branch", "old"]);
      const bare = await bareFrom(w, join(tmp.path, "b.git"));
      const c2 = await w.commit("two\n\nbody");
      const c3 = await w.commit("three");
      await w.run(["push", "-q", bare, "main", ":old", "main:refs/heads/new"]);

      const before = new Map([
        ["refs/heads/main", c1],
        ["refs/heads/old", c1],
      ]);
      const after = new Map([
        ["refs/heads/main", c3],
        ["refs/heads/new", c3],
      ]);
      const payloads = await pushPayloads(bare, before, after);
      expect(payloads.map((p) => p.ref)).toEqual(["refs/heads/main", "refs/heads/new", "refs/heads/old"]);

      const main = payloads[0]!;
      expect(main).toMatchObject({ before: c1, after: c3, totalCommitsCount: 2, commitsTruncated: false });
      const commits = main.commits as { id: string; message: string; parents: string[]; author: unknown }[];
      expect(commits.map((c) => c.id)).toEqual([c3, c2]);
      expect(commits[1]).toMatchObject({
        message: "two\n\nbody",
        parents: [c1],
        author: { name: "Ada Author", email: "ada@example.com" },
      });

      expect(payloads[1]).toMatchObject({ before: "0".repeat(40), after: c3, totalCommitsCount: 2 });
      expect(payloads[2]).toMatchObject({ before: c1, after: "0".repeat(40), commits: [], totalCommitsCount: 0 });
      expect(await pushPayloads(bare, after, after)).toEqual([]);
    } finally {
      await tmp.cleanup();
    }
  });

  it("truncates long pushes to 20 commits", async () => {
    const tmp = await tempDir();
    try {
      const w = await WorkTree.init(join(tmp.path, "w"));
      for (let i = 0; i < 25; i++) await w.commit(`c${i}`);
      const bare = await bareFrom(w, join(tmp.path, "b.git"));
      const head = await w.head();
      const [p] = await pushPayloads(bare, new Map(), new Map([["refs/heads/main", head]]));
      expect(p).toMatchObject({ totalCommitsCount: 25, commitsTruncated: true });
      expect((p!.commits as unknown[]).length).toBe(20);
    } finally {
      await tmp.cleanup();
    }
  });
});
