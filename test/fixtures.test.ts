import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.ts";
import { tempDir } from "./helpers.ts";
import { normalize } from "./record/normalize.ts";
import { type Exchange, runScenario } from "./record/scenario.ts";

// Replays the recorded live scenario against the emulator and compares, exchange by exchange.
// Refresh the fixture with `npm run record`. Set ARTIFACTS_OFFLINE=1 to skip the steps that
// import from GitHub.

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/live.json"), "utf8")) as {
  recordedAt: string;
  exchanges: Exchange[];
};
const OFFLINE = process.env.ARTIFACTS_OFFLINE === "1";
const NETWORK_LABELS = new Set([
  "import https",
  "get imported",
  "token for imported",
  "ls-remote imported",
  "import not a repo",
  "import missing github repo",
]);

/**
 * Fields whose values legitimately differ between the service and the emulator; their presence
 * and type are still compared.
 *  - objects: the fork's object count depends on how each side packs.
 */
const VOLATILE = new Set(["objects"]);

function comparable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(comparable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.has(k) ? typeof x : comparable(x)]));
  }
  return v;
}

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let local: Exchange[];

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data") });
  const namespace = "fixture-ns";
  local = normalize(
    await runScenario(
      { account: `${srv.url}/client/v4/accounts/fixture/artifacts`, token: "fixture", namespace },
      { skipNetworkImports: OFFLINE },
    ),
    namespace,
  );
}, 120_000);

afterAll(async () => {
  await srv?.close();
  await tmp?.cleanup();
});

describe(`emulator matches the live recording (${fixture.recordedAt})`, () => {
  const expected = fixture.exchanges.filter((e) => !(OFFLINE && NETWORK_LABELS.has(e.label)));

  it("runs the same sequence of steps", () => {
    expect(local.map((e) => e.label)).toEqual(expected.map((e) => e.label));
  });

  expected.forEach((want, i) => {
    it(`#${i} ${want.kind} ${want.label}`, () => {
      expect(comparable(local[i]!)).toEqual(comparable(want));
    });
  });
});
