import { describe, expect, it } from "vitest";
import { encodePkts, filterCapabilities, parsePkts, rewriteAdvertisement } from "../src/capabilities.ts";

const SHA = "a".repeat(40);
const pkt = (s: string) => Buffer.from(s, "latin1");

// What git 2.55's http-backend sends with CAPABILITY_CONFIG applied, and what the live service
// sent on 2026-10-08.
const GIT_UPLOAD_V0 = encodePkts([
  pkt("# service=git-upload-pack\n"),
  "flush",
  pkt(
    `${SHA} HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed no-done allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/main object-format=sha1 agent=git/2.55.0\n`,
  ),
  pkt(`${SHA} refs/heads/main\n`),
  "flush",
]);
const LIVE_UPLOAD_V0_CAPS =
  "agent=artifacts-local object-format=sha1 multi_ack multi_ack_detailed no-done side-band side-band-64k shallow deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress symref=HEAD:refs/heads/main";

const GIT_RECEIVE = encodePkts([
  pkt("# service=git-receive-pack\n"),
  "flush",
  pkt(
    `${SHA} refs/heads/main\0report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=git/2.55.0\n`,
  ),
  "flush",
]);

const GIT_UPLOAD_V2 = encodePkts([
  pkt("version 2\n"),
  pkt("agent=git/2.55.0\n"),
  pkt("ls-refs=unborn\n"),
  pkt("fetch=shallow wait-for-done filter\n"),
  pkt("server-option\n"),
  pkt("object-format=sha1\n"),
  "flush",
]);

const lines = (b: Buffer) => parsePkts(b).map((p) => (p instanceof Buffer ? p.toString("latin1") : p));

describe("pkt-lines", () => {
  it("round-trips data, flush, and delim packets", () => {
    const b = encodePkts([pkt("hello\n"), "delim", pkt("x"), "flush"]);
    // 000a"hello\n" | 0001 (delim) | 0005"x" | 0000 (flush)
    expect(b.toString()).toBe("000ahello\n00010005x0000");
    expect(lines(b)).toEqual(["hello\n", "delim", "x", "flush"]);
  });

  it("rejects malformed framing", () => {
    expect(() => parsePkts(Buffer.from("zzzz"))).toThrow(/bad pkt-line length/);
    expect(() => parsePkts(Buffer.from("0002"))).toThrow(/bad pkt-line length 2/);
    expect(() => parsePkts(Buffer.from("00ffab"))).toThrow(/bad pkt-line length 255/);
  });
});

describe("filterCapabilities", () => {
  it("keeps allowed names in the allowed order, takes literal entries as given", () => {
    expect(filterCapabilities(["b", "a=1", "c"], ["a", "x=2", "b", "missing"])).toEqual(["a=1", "x=2", "b"]);
  });
});

describe("rewriteAdvertisement", () => {
  it("gives upload-pack v0 the live capability set and order", () => {
    const out = lines(rewriteAdvertisement(GIT_UPLOAD_V0, "git-upload-pack"));
    expect(out[0]).toBe("# service=git-upload-pack\n");
    expect(out[2]).toBe(`${SHA} HEAD\0${LIVE_UPLOAD_V0_CAPS}\n`);
    expect(out.slice(3)).toEqual([`${SHA} refs/heads/main\n`, "flush"]);
  });

  it("drops atomic, quiet, report-status-v2 and push options from receive-pack", () => {
    const out = lines(rewriteAdvertisement(GIT_RECEIVE, "git-receive-pack"));
    expect(out[2]).toBe(`${SHA} refs/heads/main\0report-status delete-refs ofs-delta side-band-64k\n`);
  });

  it("replaces the v2 advertisement with the live one, behind a service line", () => {
    expect(lines(rewriteAdvertisement(GIT_UPLOAD_V2, "git-upload-pack"))).toEqual([
      "# service=git-upload-pack\n",
      "flush",
      "version 2\n",
      "agent=artifacts-local\n",
      "ls-refs=unborn\n",
      "fetch=shallow filter sideband-all\n",
      "object-format=sha1\n",
      "flush",
    ]);
  });

  it("leaves a v2 receive-pack advertisement, unparseable input, and capability-less input alone", () => {
    expect(rewriteAdvertisement(GIT_UPLOAD_V2, "git-receive-pack")).toEqual(GIT_UPLOAD_V2);
    expect(rewriteAdvertisement(Buffer.from("not pkt"), "git-upload-pack")).toEqual(Buffer.from("not pkt"));
    const noCaps = encodePkts([pkt("# service=git-upload-pack\n"), "flush", "flush"]);
    expect(rewriteAdvertisement(noCaps, "git-upload-pack")).toEqual(noCaps);
  });
});
