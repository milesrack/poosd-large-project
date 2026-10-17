import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../server/config.ts";

const production = {
  PUBLIC_DEPLOYMENT: "true",
  BETTER_AUTH_URL: "https://zetafly.example",
  BETTER_AUTH_SECRET: "x".repeat(48),
  RESEND_API_KEY: "test-key",
  EMAIL_FROM: "Zetafly <hello@zetafly.example>",
};

test("local configuration permits development origins without requiring a mail key", () => {
  const config = readConfig({});
  assert.equal(config.publicDeployment, false);
  assert.ok(config.origins.includes("http://localhost:5173"));
});

test("public configuration restricts origins to the configured HTTPS domain", () => {
  const config = readConfig(production);
  assert.equal(config.publicDeployment, true);
  assert.deepEqual(config.origins, ["https://zetafly.example"]);
});

test("public deployment rejects incomplete or unsafe configuration", () => {
  for (const override of [
    { BETTER_AUTH_URL: "http://zetafly.example" },
    { BETTER_AUTH_URL: "https://localhost" },
    { BETTER_AUTH_URL: "https://127.0.0.2" },
    { BETTER_AUTH_URL: "https://zetafly.example:8443" },
    { BETTER_AUTH_SECRET: "short" },
    { RESEND_API_KEY: "" },
    { EMAIL_FROM: "" },
    { EMAIL_FROM: "Zetafly <hello@zetafly.local>" },
  ]) {
    assert.throws(() => readConfig({ ...production, ...override }));
  }

  for (const BETTER_AUTH_URL of [
    "https://user:password@zetafly.example",
    "https://zetafly.example/path",
    "https://zetafly.example?query=1",
    "file:///tmp/site",
  ]) {
    assert.throws(() => readConfig({ BETTER_AUTH_URL }));
  }
});
