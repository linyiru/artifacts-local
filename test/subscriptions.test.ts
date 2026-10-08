import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events.ts";
import { ACCOUNT_EVENTS, REPO_EVENTS, Subscriptions, shortEventName } from "../src/subscriptions.ts";

const repoSource = { type: "artifacts.repo", namespace: "default", repo_name: "app" };

describe("shortEventName", () => {
  it.each([
    ["cf.artifacts.repo.created", "repo.created"],
    ["cf.artifacts.repo.forked", "repo.forked"],
    ["cf.artifacts.repo.pushed", "pushed"],
    ["cf.artifacts.repo.cloned", "cloned"],
    ["cf.artifacts.repo.token.created", "token.created"],
  ])("%s → %s", (type, short) => {
    expect(shortEventName(type)).toBe(short);
  });
});

const subs = () => new Subscriptions(() => Date.parse("2026-10-08T00:00:00Z"));

describe("Subscriptions.create", () => {
  it("defaults to every event of the source, enabled, with a generated name and id", () => {
    const s = subs().create("q", { source: { type: "artifacts" } });
    expect(s).toMatchObject({ queue: "q", name: "q-artifacts", enabled: true, events: [...ACCOUNT_EVENTS] });
    expect(s.id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.created_at).toBe("2026-10-08T00:00:00.000Z");
    expect(subs().create("q", { source: repoSource }).events).toEqual([...REPO_EVENTS]);
  });

  it("takes a name, enabled flag, and event list, de-duplicated", () => {
    const s = subs().create("q", { name: "n", enabled: false, source: repoSource, events: ["pushed", "pushed"] });
    expect(s).toMatchObject({ name: "n", enabled: false, events: ["pushed"], source: repoSource });
  });

  it.each([
    [{ source: { type: "kv" } }, /source.type/],
    [{}, /source.type/],
    [{ source: { type: "artifacts.repo", namespace: "default" } }, /repo_name/],
    [{ source: { type: "artifacts.repo", repo_name: "x" } }, /namespace/],
    [{ source: { type: "artifacts" }, events: ["pushed"] }, /events must be/],
    [{ source: repoSource, events: ["repo.created"] }, /events must be/],
    [{ source: repoSource, events: [] }, /events must be/],
    [{ source: repoSource, events: "pushed" }, /events must be/],
  ])("rejects %j", (input, message) => {
    expect(() => subs().create("q", input)).toThrow(message);
  });

  it("requires a queue", () => {
    expect(() => subs().create("", { source: { type: "artifacts" } })).toThrow(/queue/);
  });

  it("lists by queue and deletes", () => {
    const s = subs();
    const a = s.create("q1", { source: { type: "artifacts" } });
    s.create("q2", { source: repoSource });
    expect(s.list().map((x) => x.queue)).toEqual(["q1", "q2"]);
    expect(s.list("q1")).toEqual([a]);
    expect(s.delete(a.id)).toBe(true);
    expect(s.delete(a.id)).toBe(false);
    expect(s.list("q1")).toEqual([]);
  });
});

describe("delivery", () => {
  it("routes each event to the matching subscriptions, stamped with their id", () => {
    const bus = new EventBus("acct", () => 1000);
    const account = bus.subscriptions.create("events", { source: { type: "artifacts" } });
    const repo = bus.subscriptions.create("events", { source: repoSource, events: ["pushed"] });
    const other = bus.subscriptions.create("other", { source: { ...repoSource, repo_name: "elsewhere" } });
    bus.subscriptions.create("off", { source: { type: "artifacts" }, enabled: false });

    bus.emit("cf.artifacts.repo.created", "default", "app", { repoId: "r" });
    bus.emit("cf.artifacts.repo.pushed", "default", "app", { ref: "refs/heads/main" });
    bus.emit("cf.artifacts.repo.cloned", "default", "app", {});
    bus.emit("cf.artifacts.repo.pushed", "default", "unrelated", {});
    bus.emit("cf.artifacts.repo.pushed", "staging", "app", {});

    const { messages, next } = bus.subscriptions.pull("events");
    expect(messages.map((m) => [m.body.type, m.body.metadata.eventSubscriptionId])).toEqual([
      ["cf.artifacts.repo.created", account.id],
      ["cf.artifacts.repo.pushed", repo.id],
    ]);
    expect(messages[0]).toMatchObject({ seq: 1, timestamp_ms: 1000, id: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(next).toBe(messages[1]!.seq);
    expect(bus.subscriptions.pull("other").messages).toEqual([]);
    expect(bus.subscriptions.pull("off").messages).toEqual([]);
    expect(other.events).toEqual([...REPO_EVENTS]);
    // The unsubscribed history keeps its own id.
    expect(bus.history[0]!.metadata.eventSubscriptionId).toBe("local");
  });

  it("keeps the live field order: type, source, metadata, payload", () => {
    const bus = new EventBus("acct");
    const e = bus.emit("cf.artifacts.repo.pushed", "default", "app", {});
    expect(Object.keys(e)).toEqual(["type", "source", "metadata", "payload"]);
    expect(Object.keys(e.source)).toEqual(["namespace", "repoName", "type"]);
  });

  it("resumes after a position, honours a limit, and caps each feed", () => {
    const s = new Subscriptions(Date.now, 3);
    s.create("q", { source: repoSource });
    const bus = new EventBus("acct");
    for (let i = 0; i < 5; i++) {
      s.deliver(bus.emit("cf.artifacts.repo.pushed", "default", "app", { i }));
    }
    const all = s.pull("q");
    expect(all.messages.map((m) => m.body.payload.i)).toEqual([2, 3, 4]);
    const first = s.pull("q", 0, 1);
    expect(first.messages).toHaveLength(1);
    expect(s.pull("q", first.next).messages.map((m) => m.body.payload.i)).toEqual([3, 4]);
    expect(s.pull("q", all.next)).toEqual({ messages: [], next: all.next });
    expect(s.pull("missing")).toEqual({ messages: [], next: 0 });
  });
});
