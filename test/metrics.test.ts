import { describe, expect, it } from "vitest";
import { DIMENSIONS, Metrics, dimensionValue } from "../src/metrics.ts";

const at = (iso: string) => Date.parse(iso);

function sample(): Metrics {
  let clock = at("2026-10-08T10:07:30Z");
  const m = new Metrics(() => clock);
  const add = (ns: string, repo: string, eventType: string, durationMs: number, errorMessage?: string) =>
    m.record({
      repositoryNamespace: ns,
      repositoryName: repo,
      eventKind: errorMessage ? "error" : "action",
      eventType,
      durationMs,
      errorMessage,
    });
  add("default", "app", "push", 200);
  add("default", "app", "push", 400);
  add("default", "app", "pull", 100);
  add("default", "web", "push", 300);
  add("staging", "app", "create", 0);
  clock = at("2026-10-08T17:59:00Z");
  add("default", "app", "clientError", 10, "read rejected");
  return m;
}

describe("Metrics", () => {
  it("groups by dimensions with count, sum, avg, and quantiles, ordered by count", () => {
    const [top, ...rest] = sample().groups({ eventKind: "action" }, ["repository", "eventType"]);
    expect(top).toEqual({
      count: 2,
      sum: { durationMs: 600 },
      avg: { durationMs: 300 },
      quantiles: {
        durationMsP25: 200,
        durationMsP50: 200,
        durationMsP75: 400,
        durationMsP90: 400,
        durationMsP95: 400,
        durationMsP99: 400,
        durationMsP999: 400,
      },
      dimensions: { repository: "default/app", eventType: "push" },
    });
    expect(rest.map((g) => g.dimensions)).toEqual([
      { repository: "default/app", eventType: "pull" },
      { repository: "default/web", eventType: "push" },
      { repository: "staging/app", eventType: "create" },
    ]);
  });

  it("filters like the GraphQL dataset", () => {
    const m = sample();
    const count = (f: Parameters<Metrics["groups"]>[0]) => m.groups(f).reduce((a, g) => a + g.count, 0);
    expect(count({})).toBe(6);
    expect(count({ repositoryNamespace: "default" })).toBe(5);
    expect(count({ repositoryName: "app" })).toBe(5);
    expect(count({ repository: "default/app" })).toBe(4);
    expect(count({ eventType: "push" })).toBe(3);
    expect(count({ eventKind: "error" })).toBe(1);
    expect(count({ datetime_geq: "2026-10-08T12:00:00Z" })).toBe(1);
    expect(count({ datetime_leq: "2026-10-08T12:00:00Z" })).toBe(5);
    expect(m.groups({ eventKind: "error" }, ["eventType", "errorMessage"])[0]!.dimensions).toEqual({
      eventType: "clientError",
      errorMessage: "read rejected",
    });
  });

  it("truncates time dimensions and honours a limit", () => {
    const m = sample();
    const e = m.events[0]!;
    expect(dimensionValue(e, "date")).toBe("2026-10-08");
    expect(dimensionValue(e, "datetime")).toBe("2026-10-08T10:07:30.000Z");
    expect(dimensionValue(e, "datetimeMinute")).toBe("2026-10-08T10:07:00Z");
    expect(dimensionValue(e, "datetimeFiveMinutes")).toBe("2026-10-08T10:05:00Z");
    expect(dimensionValue(e, "datetimeFifteenMinutes")).toBe("2026-10-08T10:00:00Z");
    expect(dimensionValue(e, "datetimeHour")).toBe("2026-10-08T10:00:00Z");
    expect(dimensionValue(e, "datetimeSixHours")).toBe("2026-10-08T06:00:00Z");
    expect(dimensionValue({ ...e, repositoryName: "" }, "repository")).toBe("");
    expect(m.groups({}, ["datetimeHour"]).map((g) => [g.dimensions.datetimeHour, g.count])).toEqual([
      ["2026-10-08T10:00:00Z", 5],
      ["2026-10-08T17:00:00Z", 1],
    ]);
    expect(m.groups({}, ["repository"], 1)).toHaveLength(1);
    expect(DIMENSIONS).toContain("datetimeSixHours");
  });

  it("returns nothing for no matches and caps what it keeps", () => {
    expect(new Metrics().groups()).toEqual([]);
    const m = new Metrics(Date.now, 2);
    for (const t of ["a", "b", "c"])
      m.record({ repositoryNamespace: "n", repositoryName: t, eventKind: "action", eventType: "read", durationMs: 1 });
    expect(m.events.map((e) => e.repositoryName)).toEqual(["b", "c"]);
    expect(m.events[0]!.errorMessage).toBe("");
  });
});
