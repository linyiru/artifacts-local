// A service-binding stand-in for the Artifacts binding, for `wrangler dev`.
// Bind your Worker's ARTIFACTS to this Worker's `ArtifactsLocal` entrypoint and it
// behaves like the real binding, backed by an artifacts-local server.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createArtifactsBinding } from "../src/client.ts";
import type { Artifacts, ArtifactsRepo } from "../src/types.ts";

interface Env {
  /** artifacts-local server, e.g. http://127.0.0.1:8788 */
  ARTIFACTS_LOCAL_URL?: string;
  /** Namespace when the service binding carries no `props.namespace`. */
  ARTIFACTS_NAMESPACE?: string;
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
    const props = (this.ctx as unknown as { props?: { namespace?: string; url?: string } }).props ?? {};
    return createArtifactsBinding({
      url: props.url ?? this.env.ARTIFACTS_LOCAL_URL ?? "http://127.0.0.1:8788",
      namespace: props.namespace ?? this.env.ARTIFACTS_NAMESPACE ?? "default",
    });
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
