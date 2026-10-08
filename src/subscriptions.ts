// Event subscriptions, as Cloudflare Queues offers them for Artifacts: each subscription sends the
// matching events of one source to one queue. Here each queue is an in-memory feed that the
// wrangler shim pulls into a local Queue, or that tests read directly.
//
// Checked live on 2026-10-08: an `artifacts.repo` subscription takes `namespace` and `repo_name`
// in its source; each delivered message body is the event, with `metadata.eventSubscriptionId`
// set to the subscription's id.

import { randomBytes } from "node:crypto";
import type { ArtifactsEvent } from "./events.ts";

export const ACCOUNT_EVENTS = ["repo.created", "repo.deleted", "repo.forked", "repo.imported"] as const;
export const REPO_EVENTS = ["pushed", "cloned", "fetched", "token.created", "token.revoked"] as const;

export type SubscriptionSource =
  | { type: "artifacts" }
  | { type: "artifacts.repo"; namespace: string; repo_name: string };

export interface Subscription {
  id: string;
  name: string;
  enabled: boolean;
  queue: string;
  source: SubscriptionSource;
  events: string[];
  created_at: string;
}

export interface QueueMessage {
  /** Position in this queue's feed; pull with `after` to resume. */
  seq: number;
  id: string;
  timestamp_ms: number;
  body: ArtifactsEvent;
}

export class SubscriptionError extends Error {}

/** `cf.artifacts.repo.created` → `repo.created`; `cf.artifacts.repo.pushed` → `pushed`. */
export function shortEventName(type: string): string {
  const rest = type.replace(/^cf\.artifacts\./, "");
  return rest.startsWith("repo.") && !(ACCOUNT_EVENTS as readonly string[]).includes(rest) ? rest.slice(5) : rest;
}

const hexId = () => randomBytes(16).toString("hex");

export class Subscriptions {
  private subs = new Map<string, Subscription>();
  private feeds = new Map<string, QueueMessage[]>();
  private seq = 0;
  /** Changes when the emulator restarts and positions start over; consumers reset on a new epoch. */
  readonly epoch = hexId();
  private readonly now: () => number;
  private readonly maxPerQueue: number;

  constructor(now: () => number = Date.now, maxPerQueue = 10_000) {
    this.now = now;
    this.maxPerQueue = maxPerQueue;
  }

  create(queue: string, input: { name?: string; enabled?: boolean; source?: unknown; events?: unknown }): Subscription {
    if (!queue) throw new SubscriptionError("queue is required");
    const source = input.source as { type?: unknown; namespace?: unknown; repo_name?: unknown } | undefined;
    let parsed: SubscriptionSource;
    let allowed: readonly string[];
    if (source?.type === "artifacts") {
      parsed = { type: "artifacts" };
      allowed = ACCOUNT_EVENTS;
    } else if (source?.type === "artifacts.repo") {
      if (
        typeof source.namespace !== "string" ||
        !source.namespace ||
        typeof source.repo_name !== "string" ||
        !source.repo_name
      ) {
        throw new SubscriptionError("artifacts.repo subscriptions need source.namespace and source.repo_name");
      }
      parsed = { type: "artifacts.repo", namespace: source.namespace, repo_name: source.repo_name };
      allowed = REPO_EVENTS;
    } else {
      throw new SubscriptionError('source.type must be "artifacts" or "artifacts.repo"');
    }
    const events = input.events === undefined ? [...allowed] : input.events;
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      !events.every((e) => typeof e === "string" && allowed.includes(e))
    ) {
      throw new SubscriptionError(`events must be a non-empty list of: ${allowed.join(", ")}`);
    }
    const sub: Subscription = {
      id: hexId(),
      name: input.name ?? `${queue}-${parsed.type}`,
      enabled: input.enabled ?? true,
      queue,
      source: parsed,
      events: [...new Set(events as string[])],
      created_at: new Date(this.now()).toISOString(),
    };
    this.subs.set(sub.id, sub);
    return sub;
  }

  list(queue?: string): Subscription[] {
    return [...this.subs.values()].filter((s) => !queue || s.queue === queue);
  }

  delete(id: string): boolean {
    return this.subs.delete(id);
  }

  /** Copy `event` into the feed of every enabled subscription it matches. */
  deliver(event: ArtifactsEvent): void {
    const name = shortEventName(event.type);
    for (const sub of this.subs.values()) {
      if (!sub.enabled || !sub.events.includes(name)) continue;
      if (sub.source.type !== event.source.type) continue;
      if (
        sub.source.type === "artifacts.repo" &&
        (sub.source.namespace !== event.source.namespace || sub.source.repo_name !== event.source.repoName)
      ) {
        continue;
      }
      const feed = this.feeds.get(sub.queue) ?? [];
      feed.push({
        seq: ++this.seq,
        id: hexId(),
        timestamp_ms: this.now(),
        body: { ...event, metadata: { ...event.metadata, eventSubscriptionId: sub.id } },
      });
      if (feed.length > this.maxPerQueue) feed.shift();
      this.feeds.set(sub.queue, feed);
    }
  }

  /** Messages in `queue` after position `after`, oldest first. */
  pull(queue: string, after = 0, limit = 100): { epoch: string; messages: QueueMessage[]; next: number } {
    const messages = (this.feeds.get(queue) ?? []).filter((m) => m.seq > after).slice(0, limit);
    return { epoch: this.epoch, messages, next: messages.at(-1)?.seq ?? after };
  }
}
