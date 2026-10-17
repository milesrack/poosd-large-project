import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkNewPassword } from "../server/password-check.ts";
import { passwordStrength } from "../shared/password-strength.ts";

const phrase = "giraffe orbit linen glacier";
const hash = (password: string) =>
  createHash("sha1")
    .update(password.normalize("NFKC"))
    .digest("hex")
    .toUpperCase();
const errorCode = (code: string) => (error: unknown) =>
  error instanceof Error &&
  "body" in error &&
  typeof error.body === "object" &&
  error.body !== null &&
  "code" in error.body &&
  error.body.code === code;

test("strength recognises common, repeated and keyboard patterns without requiring character classes", () => {
  for (const password of [
    "passwordpassword",
    "aaaaaaaaaaaaaaa",
    "qwertyuiopasdfgh",
  ]) {
    assert.ok(passwordStrength(password) < 2);
  }

  assert.ok(passwordStrength(phrase) >= 3);
});

test("predictable passwords are rejected before any external request", async () => {
  await assert.rejects(
    checkNewPassword("a".repeat(15), () => {
      throw Error("Must not call network");
    }),
    errorCode("PASSWORD_TOO_WEAK"),
  );
});

test("breach lookup sends only a padded five-character hash prefix and rejects an exact positive match", async () => {
  const digest = hash(phrase);

  await assert.rejects(
    checkNewPassword(phrase, async (url, options) => {
      assert.equal(
        url,
        `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
      );

      assert.equal(new Headers(options?.headers).get("Add-Padding"), "true");
      assert.ok(options?.signal instanceof AbortSignal);

      return new Response(`${digest.slice(5)}:7\r\n${"0".repeat(35)}:0`);
    }),
    errorCode("PASSWORD_COMPROMISED"),
  );
});

test("zero-count padding is ignored and screening uses the same Unicode normalisation as hashing", async () => {
  const unicode = phrase.replace(/[a-z]/g, (letter) =>
    String.fromCharCode(letter.charCodeAt(0) + 0xfee0),
  );

  await checkNewPassword(unicode, async (url) => {
    assert.equal(
      url,
      `https://api.pwnedpasswords.com/range/${hash(phrase).slice(0, 5)}`,
    );

    return new Response(`${hash(phrase).slice(5)}:0`);
  });
});

test("network failure and malformed breach responses fail closed with a retryable error", async () => {
  for (const request of [
    async () => {
      throw Error("Network failure");
    },
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("not a hash list"),
    async () => new Response(""),
  ]) {
    await assert.rejects(
      checkNewPassword(phrase, request),
      errorCode("PASSWORD_CHECK_UNAVAILABLE"),
    );
  }
});
