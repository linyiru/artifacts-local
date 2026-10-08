import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { handleBinding } from "../src/binding-rpc.ts";
import { createArtifactsBinding } from "../src/client.ts";
import { git } from "../src/git.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { WorkTree, tempDir } from "./helpers.ts";

// Which operations become which metric events, following what the live service recorded.

let tmp: Awaited<ReturnType<typeof tempDir>>;
let srv: RunningServer;

beforeAll(async () => {
  tmp = await tempDir();
  srv = await startServer({ dataDir: join(tmp.path, "data") }, [handleBinding]);
});

afterAll(async () => {
  await srv.close();
  await tmp.cleanup();
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${srv.url}/client/v4/accounts/a/artifacts${path}`, {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

const tally = () =>
  Object.fromEntries(
    srv.store.metrics
      .groups({}, ["eventKind", "eventType", "errorMessage"])
      .map((g) => [
        `${g.dimensions.eventKind}/${g.dimensions.eventType}${g.dimensions.errorMessage ? ` (${g.dimensions.errorMessage})` : ""}`,
        g.count,
      ]),
  );

describe("metrics recording", () => {
  it("records REST, git, and binding operations with the live event types", async () => {
    await api("POST", "/namespaces", { namespace: "metrics" });
    await api("GET", "/namespaces");
    await api("GET", "/namespaces/metrics");
    const created = (await api("POST", "/namespaces/metrics/repos", { name: "app" })).json.result;
    await api("POST", "/namespaces/metrics/repos", { name: "-bad" });
    await api("GET", "/namespaces/metrics/repos/app");
    await api("GET", "/namespaces/metrics/repos/missing");
    const token = (await api("POST", "/namespaces/metrics/tokens", { repo: "app", scope: "read" })).json.result;
    await api("DELETE", `/namespaces/metrics/tokens/${token.id}`);

    const w = await WorkTree.init(join(tmp.path, "w"));
    await w.commit("one");
    const auth = ["-c", `http.extraHeader=Authorization: Bearer ${created.token}`];
    await w.run([...auth, "push", "-q", created.remote, "main"]);
    await git([...auth, "clone", "-q", created.remote, join(tmp.path, "c")]);
    await git(["-C", w.dir, "push", created.remote, "main"]); // no credentials: not recorded, as live
    await api("GET", "/namespaces/metrics/repos/app/log");
    await api("POST", "/namespaces/metrics/repos/app/fork", { name: "copy" });
    await api("DELETE", "/namespaces/metrics/repos/copy");
    await api("GET", "/namespaces/metrics/widgets"); // unknown route: not an operation

    const artifacts = createArtifactsBinding({ url: srv.url, namespace: "metrics" });
    await artifacts.create("via-binding");
    using repo = await artifacts.get("via-binding");
    await repo.info();
    await repo.createToken("read", 60);
    await artifacts.get("nope").catch(() => {});

    expect(tally()).toEqual({
      "action/namespace_create": 1,
      "action/namespace_list": 1,
      "action/namespace_get": 1,
      "action/create": 2,
      "error/clientError (create rejected)": 1,
      // GET repo, log, binding get(), repo.info()
      "action/read": 4,
      "error/clientError (read rejected)": 2,
      "action/token_create": 2,
      "action/token_revoke": 1,
      "action/push": 1,
      "action/pull": 1,
      "action/fork": 1,
      "action/delete": 1,
    });
  });

  it("names the repo and namespace, and reports instant operations as 0 ms", () => {
    const byRepo = srv.store.metrics.groups({ repositoryNamespace: "metrics", eventKind: "action" }, [
      "repository",
      "eventType",
    ]);
    const find = (repository: string, eventType: string) =>
      byRepo.find((g) => g.dimensions.repository === repository && g.dimensions.eventType === eventType);
    expect(find("metrics/app", "push")!.sum.durationMs).toBeGreaterThan(0);
    expect(find("metrics/app", "create")!.sum.durationMs).toBe(0);
    expect(find("metrics/app", "fork")).toBeDefined();
    expect(find("metrics/copy", "delete")).toBeDefined();
    expect(find("metrics/via-binding", "create")).toBeDefined();
    const ns = srv.store.metrics.groups({ eventType: "namespace_create" }, ["repositoryNamespace"]);
    expect(ns[0]!.dimensions.repositoryNamespace).toBe("metrics");
  });

  it("records an unexpected failure as a serverError", async () => {
    const before = srv.store.metrics.events.length;
    srv.store.metrics.recordOperation({ type: "read", namespace: "n", repo: "r" }, 500, 3);
    expect(srv.store.metrics.events.slice(before)).toEqual([
      expect.objectContaining({
        eventKind: "error",
        eventType: "serverError",
        errorMessage: "read failed",
        durationMs: 3,
      }),
    ]);
  });
});
