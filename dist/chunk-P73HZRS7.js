import {
  ArtifactsError
} from "./chunk-Q35FWRES.js";

// src/client.ts
function toBlob(b) {
  if (!b) return null;
  const bin = atob(b.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: b.type });
}
function createArtifactsBinding(opts) {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = `${opts.url.replace(/\/$/, "")}/__local/binding/${encodeURIComponent(opts.namespace)}`;
  async function call(method, args, repo) {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, repo, args })
    });
    if (!res.ok) throw new ArtifactsError("INTERNAL_ERROR", `artifacts-local returned HTTP ${res.status}`);
    const wire = await res.json();
    if (!wire.ok) throw new ArtifactsError(wire.error.code, wire.error.message);
    return "blob" in wire ? toBlob(wire.blob) : wire.result;
  }
  function handle(name) {
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
      [Symbol.dispose]() {
      }
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
    delete: (name) => call("delete", [name])
  };
}

export {
  createArtifactsBinding
};
