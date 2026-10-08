// Rewrite git's capability advertisements to the live service's.
//
// The live service is not git: it advertises `agent=gitty/1.0` and a smaller capability set
// (captured 2026-10-08). Without this, clients use features locally that the service refuses,
// e.g. `git push --atomic` and `git push -o` succeed here but fail against Cloudflare.

export type Pkt = Buffer | "flush" | "delim";

/** Split a pkt-line stream. Throws on malformed framing. */
export function parsePkts(data: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < data.length) {
    const len = Number.parseInt(data.subarray(pos, pos + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at ${pos}`);
    if (len === 0) out.push("flush");
    else if (len === 1) out.push("delim");
    else if (len < 4 || pos + len > data.length) throw new Error(`bad pkt-line length ${len} at ${pos}`);
    else out.push(data.subarray(pos + 4, pos + len));
    pos += len < 4 ? 4 : len;
  }
  return out;
}

export function encodePkts(pkts: Pkt[]): Buffer {
  return Buffer.concat(
    pkts.map((p) => {
      if (p === "flush") return Buffer.from("0000");
      if (p === "delim") return Buffer.from("0001");
      return Buffer.concat([Buffer.from((p.length + 4).toString(16).padStart(4, "0")), p]);
    }),
  );
}

export const AGENT = "agent=artifacts-local";

/** upload-pack v0/v1 capabilities, in the live order. `symref=` and `object-format=` keep git's value. */
const UPLOAD_PACK_V0 = [
  AGENT,
  "object-format",
  "multi_ack",
  "multi_ack_detailed",
  "no-done",
  "side-band",
  "side-band-64k",
  "shallow",
  "deepen-since",
  "deepen-not",
  "deepen-relative",
  "allow-tip-sha1-in-want",
  "allow-reachable-sha1-in-want",
  "no-progress",
  "symref",
];

/** receive-pack capabilities, in the live order: no atomic, push-options, quiet, or report-status-v2. */
const RECEIVE_PACK = ["report-status", "delete-refs", "ofs-delta", "side-band-64k", "symref"];

/** upload-pack v2 capability lines, in the live order. */
const UPLOAD_PACK_V2 = [AGENT, "ls-refs=unborn", "fetch=shallow filter sideband-all", "object-format=sha1"];

export type Service = "git-upload-pack" | "git-receive-pack";

/** Keep only `allowed` capabilities (by name), in `allowed`'s order; names without `=` in the list keep git's value. */
export function filterCapabilities(caps: string[], allowed: string[]): string[] {
  const byName = new Map(caps.map((c) => [c.split("=")[0]!, c]));
  const out: string[] = [];
  for (const want of allowed) {
    if (want.includes("=")) out.push(want);
    else if (byName.has(want)) out.push(byName.get(want)!);
  }
  return out;
}

/** Rewrite the capabilities on the first ref line of a v0/v1 advertisement. */
function rewriteV0(pkts: Pkt[], service: Service): Pkt[] {
  const allowed = service === "git-upload-pack" ? UPLOAD_PACK_V0 : RECEIVE_PACK;
  const i = pkts.findIndex((p) => p instanceof Buffer && p.includes(0));
  if (i === -1) return pkts;
  const line = pkts[i] as Buffer;
  const nul = line.indexOf(0);
  const caps = line
    .subarray(nul + 1)
    .toString("latin1")
    .replace(/\n$/, "")
    .split(" ")
    .filter(Boolean);
  const next = [...pkts];
  next[i] = Buffer.concat([line.subarray(0, nul + 1), Buffer.from(`${filterCapabilities(caps, allowed).join(" ")}\n`)]);
  return next;
}

/** Replace a v2 capability advertisement with the live one, behind a `# service=` line as live sends. */
function rewriteV2(service: Service): Pkt[] {
  return [
    Buffer.from(`# service=${service}\n`),
    "flush",
    Buffer.from("version 2\n"),
    ...UPLOAD_PACK_V2.map((c) => Buffer.from(`${c}\n`)),
    "flush",
  ];
}

/** Rewrite an `info/refs` response body. Unrecognised input is returned unchanged. */
export function rewriteAdvertisement(body: Buffer, service: Service): Buffer {
  let pkts: Pkt[];
  try {
    pkts = parsePkts(body);
  } catch {
    return body;
  }
  const isV2 = pkts.some((p) => p instanceof Buffer && p.toString("latin1") === "version 2\n");
  if (isV2) return service === "git-upload-pack" ? encodePkts(rewriteV2(service)) : body;
  return encodePkts(rewriteV0(pkts, service));
}

/** git config that makes git honour what the rewritten advertisement offers. */
export const CAPABILITY_CONFIG: [string, string][] = [
  ["uploadpack.allowTipSHA1InWant", "true"],
  ["uploadpack.allowReachableSHA1InWant", "true"],
  ["uploadpack.allowSidebandAll", "true"],
  ["receive.advertiseAtomic", "false"],
  ["receive.advertisePushOptions", "false"],
];
