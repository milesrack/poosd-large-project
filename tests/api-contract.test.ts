import assert from "node:assert/strict";
import test from "node:test";
import { apiContract } from "../scripts/api-contract.ts";

const contract = await apiContract();

test("checkpoint search requires an API credential", () => {
  assert.deepEqual(contract.document.paths["/api/weights"]?.get?.security, [
    { bearerAuth: [] },
    { accessCookie: [] },
  ]);
});

test("the API contract rejects response drift and fields that could leak private model data", async () => {
  await contract.response("/api/health", Response.json({ status: "ok" }));

  await contract.response(
    "/api/health",
    Response.json({ status: "unavailable" }, { status: 503 }),
  );

  await assert.rejects(() =>
    contract.response("/api/health", Response.json({ status: "healthy" })),
  );

  await assert.rejects(() =>
    contract.response(
      "/api/weights",
      Response.json([
        {
          id: "model",
          name: "Model",
          features: 512,
          arithmeticMode: "digits",
          synaptic: false,
          sha256: "a".repeat(64),
          ownerId: "private-owner",
        },
      ]),
    ),
  );

  await assert.rejects(() =>
    contract.response(
      "/api/weights",
      Response.json({ error: "Missing" }, { status: 404 }),
    ),
  );
});
