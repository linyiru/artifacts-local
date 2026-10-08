// A drop-in stand-in for the Workers `Artifacts` binding, backed by an artifacts-local server.
// Uses only fetch/Blob/atob, so it runs in workerd (wrangler dev) as well as Node.
//
//   const artifacts = createArtifactsBinding({ url: "http://127.0.0.1:8788", namespace: "default" });
//   using repo = await artifacts.get("app");

import { ArtifactsError, type ArtifactsErrorCode } from "./errors.ts";
import type { Artifacts, ArtifactsRepo } from "./types.ts";

export interface BindingOptions {
  /** Base URL of the artifacts-local server. */
  url: string;
  namespace: string;
  fetch?: typeof fetch;
}

type Wire =
  | { ok: true; result: unknown }
  | { ok: true; blob: { base64: string; type: string } | null }
  | { ok: false; error: { code: ArtifactsErrorCode; message: string } };

function toBlob(b: { base64: string; type: string } | null): Blob | null {
  if (!b) return null;
  const bin = atob(b.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: b.type });
}

export function createArtifactsBinding(opts: BindingOptions): Artifacts {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = `${opts.url.replace(/\/$/, "")}/__local/binding/${encodeURIComponent(opts.namespace)}`;

  async function call<T>(method: string, args: unknown[], repo?: string): Promise<T> {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, repo, args }),
    });
    if (!res.ok) throw new ArtifactsError("INTERNAL_ERROR", `artifacts-local returned HTTP ${res.status}`);
    const wire = (await res.json()) as Wire;
    if (!wire.ok) throw new ArtifactsError(wire.error.code, wire.error.message);
    return ("blob" in wire ? toBlob(wire.blob) : wire.result) as T;
  }

  function handle(name: string): ArtifactsRepo {
    return {
      info: () => call("info", [], name),
      createToken: (scope, ttl) => call("createToken", [scope, ttl], name),
      listTokens: () => call("listTokens", [], name),
      revokeToken: (tokenOrId) => call("revokeToken", [tokenOrId], name),
      fork: (target, o) => call("fork", [target, o], name),
      log: (o) => call("log", [o], name),
      readCommit: (hash) => call("readCommit", [hash], name),
      readTree: (hash) => call("readTree", [hash], name),
      readBlob: (hash) => call("readBlob", [hash], name),
      readFile: (args) => call("readFile", [args], name),
      // The real handle is an RPC stub; disposing this one has nothing to release.
      [Symbol.dispose]() {},
    };
  }

  return {
    create: (name, o) => call("create", [name, o]),
    get: async (name) => {
      await call("get", [name]);
      return handle(name);
    },
    list: (o) => call("list", [o]),
    import: (params) => call("import", [params]),
    delete: (name) => call("delete", [name]),
  };
}
