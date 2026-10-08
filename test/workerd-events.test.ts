import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "rolldown";
import { handleBinding } from "../src/binding-rpc.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

// Events reach an app's queue() consumer through a local Queue, as an event subscription delivers
// them in production: emulator feed → shim's ArtifactsEventPump → queue producer → consumer.

const APP = `
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/create") {
      const r = await env.ARTIFACTS.create(url.searchParams.get("repo"));
      return Response.json(r);
    }
    if (url.pathname === "/received") {
      const keys = (await env.RECEIVED.list()).keys.map((k) => k.name).sort();
      const bodies = [];
      for (const k of keys) bodies.push(JSON.parse(await env.RECEIVED.get(k)));
      return Response.json(bodies);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      await env.RECEIVED.put(String(Date.now()) + "-" + m.id, JSON.stringify(m.body));
      m.ack();
    }
  },
};`;

const subscriptions = [
  { queue: "artifacts-events", source: { type: "artifacts" } },
  { queue: "artifacts-events", source: { type: "artifacts.repo", namespace: "default", repo_name: "evt" } },
];

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;
let port: number;
let mf: Miniflare;

async function received(): Promise<
  { type: string; metadata: { eventSubscriptionId: string }; payload: { ref?: string } }[]
> {
  return (await (await mf.dispatchFetch("http://app/received")).json()) as never;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data"), subscriptions }, [handleBinding]);
  port = (srv.server.address() as AddressInfo).port;
  const shim = await build({
    input: join(import.meta.dirname, "../worker/shim.ts"),
    platform: "neutral",
    external: ["cloudflare:workers"],
    write: false,
    output: { format: "esm" },
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "app",
          modules: true,
          script: APP,
          compatibilityDate: "2026-09-01",
          serviceBindings: { ARTIFACTS: { name: "shim", entrypoint: "ArtifactsLocal" } },
          queueConsumers: { "artifacts-events": { maxBatchTimeout: 0.05 } },
          kvNamespaces: ["RECEIVED"],
        },
        {
          name: "shim",
          modules: [{ type: "ESModule", path: "shim.js", contents: shim.output[0].code }],
          compatibilityDate: "2026-09-01",
          bindings: {
            ARTIFACTS_LOCAL_URL: srv.url,
            ARTIFACTS_EVENTS_QUEUE: "artifacts-events",
            ARTIFACTS_EVENTS_POLL_MS: "50",
          },
          queueProducers: { ARTIFACTS_EVENTS: "artifacts-events" },
          durableObjects: { ARTIFACTS_EVENT_PUMP: "ArtifactsEventPump" },
        },
      ],
    }),
  );
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  await srv?.close();
  await tmp?.cleanup();
});

describe("event subscriptions under workerd", () => {
  it("delivers account- and repo-level events to the app's queue consumer", async () => {
    const created = (await (await mf.dispatchFetch("http://app/create?repo=evt")).json()) as {
      remote: string;
      token: string;
    };
    const w = await WorkTree.init(join(tmp.path, "w"));
    await w.commit("hello queue");
    await w.run([
      "-c",
      `http.extraHeader=Authorization: Bearer ${created.token}`,
      "push",
      "-q",
      created.remote,
      "main",
    ]);

    const got = await waitFor(received, (b) => b.some((e) => e.type === "cf.artifacts.repo.pushed"));
    const types = got.map((e) => e.type);
    expect(types).toContain("cf.artifacts.repo.created");
    expect(types).toContain("cf.artifacts.repo.token.created");
    expect(types).toContain("cf.artifacts.repo.pushed");
    const [account, repo] = srv.store.events.subscriptions.list("artifacts-events");
    expect(got.find((e) => e.type === "cf.artifacts.repo.created")!.metadata.eventSubscriptionId).toBe(account!.id);
    const pushed = got.find((e) => e.type === "cf.artifacts.repo.pushed")!;
    expect(pushed.metadata.eventSubscriptionId).toBe(repo!.id);
    expect(pushed.payload.ref).toBe("refs/heads/main");
  });

  it("keeps delivering after the emulator restarts on the same port", async () => {
    const before = (await received()).length;
    await srv.close();
    srv = await startServer({ dataDir: join(tmp.path, "data"), port, subscriptions }, [handleBinding]);
    await mf.dispatchFetch("http://app/create?repo=after-restart");
    const got = await waitFor(received, (b) => b.length > before);
    expect(got.slice(before).map((e) => e.type)).toContain("cf.artifacts.repo.created");
  });
});
