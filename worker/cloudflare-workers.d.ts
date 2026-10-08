// Just the parts of `cloudflare:workers` the shim uses, so it type-checks without workers-types.
declare module "cloudflare:workers" {
  export class RpcTarget {}
  export class WorkerEntrypoint<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
