// Operation metrics in the shape of the `artifactsEventsAdaptiveGroups` GraphQL dataset.
//
// The event types follow what the live service recorded on 2026-10-08, which is more than the
// docs list: besides create, fork, push, pull, and delete it records read, token_create,
// token_revoke, and namespace_{list,get,create,delete}; failures are clientError
// ("<op> rejected") or serverError ("<op> failed"). Git authentication failures were not
// recorded, and create/delete/fork/token operations reported a duration of 0.

export type EventKind = "action" | "error";

export interface MetricEvent {
  datetime: string;
  repositoryNamespace: string;
  repositoryName: string;
  eventKind: EventKind;
  eventType: string;
  errorMessage: string;
  durationMs: number;
}

export const DIMENSIONS = [
  "repository",
  "repositoryNamespace",
  "repositoryName",
  "eventKind",
  "eventType",
  "errorMessage",
  "date",
  "datetime",
  "datetimeMinute",
  "datetimeFiveMinutes",
  "datetimeFifteenMinutes",
  "datetimeHour",
  "datetimeSixHours",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Filter {
  datetime_geq?: string;
  datetime_leq?: string;
  repository?: string;
  repositoryNamespace?: string;
  repositoryName?: string;
  eventKind?: EventKind;
  eventType?: string;
}

export interface Group {
  count: number;
  sum: { durationMs: number };
  avg: { durationMs: number };
  quantiles: Record<
    | "durationMsP25"
    | "durationMsP50"
    | "durationMsP75"
    | "durationMsP90"
    | "durationMsP95"
    | "durationMsP99"
    | "durationMsP999",
    number
  >;
  dimensions: Partial<Record<Dimension, string>>;
}

function truncate(iso: string, minutes: number): string {
  const ms = 60_000 * minutes;
  return new Date(Math.floor(Date.parse(iso) / ms) * ms).toISOString().replace(".000Z", "Z");
}

export function dimensionValue(e: MetricEvent, d: Dimension): string {
  switch (d) {
    case "repository":
      return e.repositoryNamespace && e.repositoryName ? `${e.repositoryNamespace}/${e.repositoryName}` : "";
    case "date":
      return e.datetime.slice(0, 10);
    case "datetime":
      return e.datetime;
    case "datetimeMinute":
      return truncate(e.datetime, 1);
    case "datetimeFiveMinutes":
      return truncate(e.datetime, 5);
    case "datetimeFifteenMinutes":
      return truncate(e.datetime, 15);
    case "datetimeHour":
      return truncate(e.datetime, 60);
    case "datetimeSixHours":
      return truncate(e.datetime, 360);
    default:
      return String(e[d]);
  }
}

/** Nearest-rank quantile of sorted values. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export class Metrics {
  readonly events: MetricEvent[] = [];
  private readonly now: () => number;
  private readonly max: number;

  constructor(now: () => number = Date.now, max = 100_000) {
    this.now = now;
    this.max = max;
  }

  record(e: Omit<MetricEvent, "datetime" | "errorMessage"> & { errorMessage?: string }): void {
    this.events.push({ ...e, errorMessage: e.errorMessage ?? "", datetime: new Date(this.now()).toISOString() });
    if (this.events.length > this.max) this.events.shift();
  }

  /** Group matching events by `by`, like `artifactsEventsAdaptiveGroups`, ordered by count desc. */
  groups(filter: Filter = {}, by: Dimension[] = [], limit = 100): Group[] {
    const matching = this.events.filter(
      (e) =>
        (!filter.datetime_geq || e.datetime >= filter.datetime_geq) &&
        (!filter.datetime_leq || e.datetime <= filter.datetime_leq) &&
        (!filter.repository || dimensionValue(e, "repository") === filter.repository) &&
        (!filter.repositoryNamespace || e.repositoryNamespace === filter.repositoryNamespace) &&
        (!filter.repositoryName || e.repositoryName === filter.repositoryName) &&
        (!filter.eventKind || e.eventKind === filter.eventKind) &&
        (!filter.eventType || e.eventType === filter.eventType),
    );
    const buckets = new Map<string, MetricEvent[]>();
    for (const e of matching) {
      const key = JSON.stringify(by.map((d) => dimensionValue(e, d)));
      buckets.set(key, [...(buckets.get(key) ?? []), e]);
    }
    const groups: Group[] = [];
    for (const [key, es] of buckets) {
      const values = JSON.parse(key) as string[];
      const durations = es.map((e) => e.durationMs).toSorted((a, b) => a - b);
      const sum = durations.reduce((a, b) => a + b, 0);
      groups.push({
        count: es.length,
        sum: { durationMs: sum },
        avg: { durationMs: sum / es.length },
        quantiles: {
          durationMsP25: quantile(durations, 0.25),
          durationMsP50: quantile(durations, 0.5),
          durationMsP75: quantile(durations, 0.75),
          durationMsP90: quantile(durations, 0.9),
          durationMsP95: quantile(durations, 0.95),
          durationMsP99: quantile(durations, 0.99),
          durationMsP999: quantile(durations, 0.999),
        },
        dimensions: Object.fromEntries(by.map((d, i) => [d, values[i]!])),
      });
    }
    return groups.toSorted((a, b) => b.count - a.count).slice(0, limit);
  }
}
