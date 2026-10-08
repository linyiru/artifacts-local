import { describe, expect, it } from "vitest";
import { join } from "node:path";
import * as api from "../src/index.ts";
import { tempDir } from "./helpers.ts";

describe("public entry point", () => {
  it("exports the server, store, binding client, and errors", () => {
    expect(Object.keys(api).toSorted()).toEqual([
      "ArtifactsError",
      "EventBus",
      "Store",
      "createArtifactsBinding",
      "handleBinding",
      "isArtifactsError",
      "startServer",
      "webhookListener",
    ]);
  });

  it("is enough to run the emulator and call it through the binding client", async () => {
    const tmp = await tempDir();
    const srv = await api.startServer({ dataDir: join(tmp.path, "data") }, [api.handleBinding]);
    try {
      const artifacts: api.Artifacts = api.createArtifactsBinding({ url: srv.url, namespace: "default" });
      const created = await artifacts.create("from-index");
      expect(created.remote).toBe(`${srv.url}/git/default/from-index.git`);
      await expect(artifacts.get("missing")).rejects.toBeInstanceOf(api.ArtifactsError);
    } finally {
      await srv.close();
      await tmp.cleanup();
    }
  });
});
