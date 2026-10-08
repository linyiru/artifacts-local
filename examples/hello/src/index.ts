// Minimal app using env.ARTIFACTS exactly as documented. Runs unchanged against
// the real binding in production and the artifacts-local shim under `wrangler dev -e local`.

interface Env {
  ARTIFACTS: {
    create(name: string, opts?: { description?: string }): Promise<{ name: string; remote: string; token: string }>;
    get(name: string): Promise<{
      info(): Promise<unknown>;
      log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string; message: string }[]>;
      readFile(args: { ref: string; path: string }): Promise<Blob | null>;
      fork(name: string, opts?: { description?: string }): Promise<{ name: string; remote: string; token: string }>;
      [Symbol.dispose](): void;
    }>;
    list(opts?: { limit?: number }): Promise<{ repos: { name: string; status: string }[]; total: number }>;
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const name = url.searchParams.get("repo") ?? "hello";
    try {
      switch (url.pathname) {
        case "/create":
          return Response.json(await env.ARTIFACTS.create(name, { description: "made by the hello example" }));
        case "/readme": {
          using repo = await env.ARTIFACTS.get(name);
          const file = await repo.readFile({ ref: "main", path: "README.md" });
          if (!file) return new Response("no README.md\n", { status: 404 });
          return new Response(await file.text(), { headers: { "content-type": file.type } });
        }
        case "/log": {
          using repo = await env.ARTIFACTS.get(name);
          return Response.json(await repo.log({ limit: 10 }));
        }
        case "/fork": {
          using repo = await env.ARTIFACTS.get(name);
          return Response.json(await repo.fork(url.searchParams.get("to") ?? `${name}-fork`));
        }
        case "/list":
          return Response.json(await env.ARTIFACTS.list());
      }
      return new Response("routes: /create /readme /log /fork /list  (?repo=name)\n");
    } catch (e) {
      const err = e as { name?: string; code?: string; message?: string };
      return Response.json({ error: { name: err.name, code: err.code, message: err.message } }, { status: 400 });
    }
  },
};
