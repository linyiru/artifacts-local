// A service-binding stand-in for the Artifacts binding, for `wrangler dev`.
// Bind your Worker's ARTIFACTS to this Worker's `ArtifactsLocal` entrypoint and it
// behaves like the real binding, backed by an artifacts-local server.
//
// Optionally it also stands in for an event subscription: with a queue producer bound as
// ARTIFACTS_EVENTS, the ArtifactsEventPump Durable Object moves the emulator's events for
// ARTIFACTS_EVENTS_QUEUE into that queue, so the app's queue() consumer runs as in production.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createArtifactsBinding } from "../src/client.ts";
import type { Artifacts, ArtifactsRepo } from "../src/types.ts";

interface Queue {
  sendBatch(messages: { body: unknown; contentType?: "json" }[]): Promise<void>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { start(): Promise<void> };
}

interface Env {
  /** artifacts-local server, e.g. http://127.0.0.1:8788 */
  ARTIFACTS_LOCAL_URL?: string;
  /** Namespace when the service binding carries no `props.namespace`. */
  ARTIFACTS_NAMESPACE?: string;
  /** Queue producer to deliver events to. */
  ARTIFACTS_EVENTS?: Queue;
  /** The emulator's queue name to read, as given to `--subscribe <queue>:…` (default artifacts-events). */
  ARTIFACTS_EVENTS_QUEUE?: string;
  /** The ArtifactsEventPump Durable Object. */
  ARTIFACTS_EVENT_PUMP?: DurableObjectNamespace;
  /** How often the pump polls, in ms (default 250). */
  ARTIFACTS_EVENTS_POLL_MS?: string;
}

const serverUrl = (env: Env) => (env.ARTIFACTS_LOCAL_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");

/** Moves events from the emulator's queue feed into the local Queue, polling on an alarm. */
export class ArtifactsEventPump extends DurableObject<Env> {
  async start(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const queue = this.env.ARTIFACTS_EVENTS_QUEUE ?? "artifacts-events";
    try {
      const epoch = await this.ctx.storage.get<string>("epoch");
      let after = (await this.ctx.storage.get<number>("after")) ?? 0;
      const res = await fetch(
        `${serverUrl(this.env)}/__local/queues/${encodeURIComponent(queue)}/messages?after=${after}`,
      );
      const feed = (await res.json()) as { epoch: string; messages: { body: unknown }[]; next: number };
      if (feed.epoch !== epoch) {
        // The emulator restarted: its positions start over, so read the new feed from the start.
        await this.ctx.storage.put("epoch", feed.epoch);
        after = 0;
        if (epoch !== undefined) {
          await this.ctx.storage.put("after", 0);
          return;
        }
      }
      if (feed.messages.length && this.env.ARTIFACTS_EVENTS) {
        await this.env.ARTIFACTS_EVENTS.sendBatch(feed.messages.map((m) => ({ body: m.body, contentType: "json" })));
      }
      if (feed.next !== after) await this.ctx.storage.put("after", feed.next);
    } catch {
      // The emulator may not be up yet; try again on the next tick.
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + Number(this.env.ARTIFACTS_EVENTS_POLL_MS ?? 250));
    }
  }
}

class Repo extends RpcTarget {
  #inner: ArtifactsRepo;
  constructor(inner: ArtifactsRepo) {
    super();
    this.#inner = inner;
  }
  info() {
    return this.#inner.info();
  }
  createToken(scope?: "read" | "write", ttl?: number) {
    return this.#inner.createToken(scope, ttl);
  }
  listTokens() {
    return this.#inner.listTokens();
  }
  revokeToken(tokenOrId: string) {
    return this.#inner.revokeToken(tokenOrId);
  }
  fork(name: string, opts?: Parameters<ArtifactsRepo["fork"]>[1]) {
    return this.#inner.fork(name, opts);
  }
  log(opts?: Parameters<ArtifactsRepo["log"]>[0]) {
    return this.#inner.log(opts);
  }
  readCommit(hash: string) {
    return this.#inner.readCommit(hash);
  }
  readTree(hash: string) {
    return this.#inner.readTree(hash);
  }
  readBlob(hash: string) {
    return this.#inner.readBlob(hash);
  }
  readFile(args: { ref: string; path: string }) {
    return this.#inner.readFile(args);
  }
}

export class ArtifactsLocal extends WorkerEntrypoint<Env> {
  #binding(): Artifacts {
    this.#startPump();
    const props = (this.ctx as unknown as { props?: { namespace?: string; url?: string } }).props ?? {};
    return createArtifactsBinding({
      url: props.url ?? serverUrl(this.env),
      namespace: props.namespace ?? this.env.ARTIFACTS_NAMESPACE ?? "default",
    });
  }
  /** Event delivery starts with the first binding call; nothing else wakes the shim. */
  #startPump(): void {
    const ns = this.env.ARTIFACTS_EVENT_PUMP;
    if (!ns || !this.env.ARTIFACTS_EVENTS) return;
    ns.get(ns.idFromName("pump"))
      .start()
      .catch(() => {});
  }

  create(name: string, opts?: Parameters<Artifacts["create"]>[1]) {
    return this.#binding().create(name, opts);
  }
  async get(name: string) {
    return new Repo(await this.#binding().get(name));
  }
  list(opts?: Parameters<Artifacts["list"]>[0]) {
    return this.#binding().list(opts);
  }
  import(params: Parameters<Artifacts["import"]>[0]) {
    return this.#binding().import(params);
  }
  delete(name: string) {
    return this.#binding().delete(name);
  }
}

export default {
  fetch() {
    return new Response("artifacts-local shim: bind to the ArtifactsLocal entrypoint\n");
  },
};
