// Just the parts of `cloudflare:workers` the shim uses, so it type-checks without workers-types.
declare module "cloudflare:workers" {
  export class RpcTarget {}
  export class WorkerEntrypoint<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(when: number): Promise<void>;
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
  }
  export class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
