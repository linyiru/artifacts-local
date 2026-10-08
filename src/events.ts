// Event envelopes in the shape of the Artifacts event subscriptions docs.

export type ArtifactsEventType =
  | "cf.artifacts.repo.created"
  | "cf.artifacts.repo.deleted"
  | "cf.artifacts.repo.forked"
  | "cf.artifacts.repo.imported"
  | "cf.artifacts.repo.pushed"
  | "cf.artifacts.repo.cloned"
  | "cf.artifacts.repo.fetched"
  | "cf.artifacts.repo.token.created"
  | "cf.artifacts.repo.token.revoked";

export interface ArtifactsEvent {
  type: ArtifactsEventType;
  source: { type: "artifacts" | "artifacts.repo"; namespace: string; repoName: string };
  payload: Record<string, unknown>;
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: 1;
    eventTimestamp: string;
  };
}

// Account-level events come from the `artifacts` source; the rest from `artifacts.repo`.
const ACCOUNT_LEVEL = new Set<ArtifactsEventType>([
  "cf.artifacts.repo.created",
  "cf.artifacts.repo.deleted",
  "cf.artifacts.repo.forked",
  "cf.artifacts.repo.imported",
]);

export type EventListener = (event: ArtifactsEvent) => void | Promise<void>;

export class EventBus {
  readonly accountId: string;
  readonly history: ArtifactsEvent[] = [];
  readonly maxHistory: number;
  private listeners = new Set<EventListener>();
  private now: () => number;

  constructor(accountId: string, now: () => number = Date.now, maxHistory = 1000) {
    this.accountId = accountId;
    this.now = now;
    this.maxHistory = maxHistory;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: ArtifactsEventType, namespace: string, repoName: string, payload: Record<string, unknown>): ArtifactsEvent {
    const event: ArtifactsEvent = {
      type,
      source: { type: ACCOUNT_LEVEL.has(type) ? "artifacts" : "artifacts.repo", namespace, repoName },
      payload,
      metadata: {
        accountId: this.accountId,
        eventSubscriptionId: "local",
        eventSchemaVersion: 1,
        eventTimestamp: new Date(this.now()).toISOString(),
      },
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const l of this.listeners) {
      // A failing subscriber must not break the operation that emitted the event.
      Promise.resolve()
        .then(() => l(event))
        .catch(() => {});
    }
    return event;
  }
}

/** POST each event as JSON to a URL, the local stand-in for a Queue consumer. */
export function webhookListener(url: string, fetchImpl: typeof fetch = fetch): EventListener {
  return async (event) => {
    await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  };
}
