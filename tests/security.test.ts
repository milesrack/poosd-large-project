import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { securityHeaders } from "../server/security.ts";

for (const publicDeployment of [false, true]) {
  test(`${publicDeployment ? "public" : "local"} HTTP security headers`, async () => {
    const app = express();
    app.use(securityHeaders(publicDeployment));
    app.get("/", (_req, res) => res.send("Zetafly"));
    const server = createServer(app);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const policy = response.headers.get("content-security-policy") ?? "";

      assert.equal(
        policy.includes("upgrade-insecure-requests"),
        publicDeployment,
      );

      assert.equal(
        response.headers.has("strict-transport-security"),
        publicDeployment,
      );

      assert.ok(policy.includes("script-src 'self'"));
      assert.ok(policy.includes("object-src 'none'"));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await response.text(), "Zetafly");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}
