import type { Exchange } from "./scenario.ts";

// Recordings differ run to run in ids, hashes, timestamps, tokens, hosts, and the namespace.
// Normalising replaces those with placeholders so two runs, or two targets, compare equal.

export function normalize(exchanges: Exchange[], namespace: string, extraSecrets: string[] = []): Exchange[] {
  const text = JSON.stringify(exchanges);
  let s = text;
  for (const secret of extraSecrets) if (secret) s = s.split(secret).join("<secret>");
  s = s
    .split(namespace)
    .join("<ns>")
    .replace(/art_v\d(?:_[a-z])?_[0-9a-f]{40}(?:\?expires=\d+)?/g, "<token>")
    .replace(/https?:\/\/[^/"\\]+\/git\//g, "<host>/git/")
    // Not \b: inside JSON a hash often follows an escape such as \n, which is no word boundary.
    .replace(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g, "<sha>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<time>")
    .replace(/"(id|tokenId|repoId)":"[0-9a-z]{16}"/g, '"$1":"<id>"')
    .replace(/\/tokens\/[0-9a-z]{16}"/g, '/tokens/<id>"')
    .replace(/"cursor":"[^"]+"/g, '"cursor":"<cursor>"')
    .replace(/cursor=[^"&]+/g, "cursor=<cursor>")
    .replace(/"(authoredAt|committedAt)":\d+/g, '"$1":0');
  return JSON.parse(s) as Exchange[];
}

/** A comparable view of a value: object keys and primitive types, recursively. */
export function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
  }
  return v === null ? "null" : typeof v;
}
