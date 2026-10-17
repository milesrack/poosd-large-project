import assert from "node:assert/strict";
import test from "node:test";
import { sendAccountEmail } from "../server/email.ts";

test("local mail and Resend share the same verification content", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const requests: {
    url: URL | RequestInfo;
    options: RequestInit | undefined;
    body: { Text: string; HTML: string; text: string; html: string };
  }[] = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(String(options?.body)) });

    return new Response(null, { status: 200 });
  };

  try {
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = "Zetafly <hello@example.com>";

    await sendAccountEmail(
      "reader@example.test",
      "http://localhost:3000/verify?x=1&y=2",
      "verification",
    );

    process.env.RESEND_API_KEY = "test-placeholder";

    await sendAccountEmail(
      "reader@example.test",
      "http://localhost:3000/verify?x=1&y=2",
      "verification",
    );

    assert.equal(requests[0].body.Text, requests[1].body.text);
    assert.equal(requests[0].body.HTML, requests[1].body.html);
    assert.ok(requests[0].body.HTML.includes("x=1&amp;y=2"));
    assert.equal(requests[1].url, "https://api.resend.com/emails");
    assert.match(requests[1].body.text, /expires in 1 hour/);

    await sendAccountEmail(
      "reader@example.test",
      "http://localhost:3000/reset?token=sample",
      "reset",
    );

    assert.match(requests[2].body.text, /expires in 15 minutes/);
    assert.match(requests[2].body.html, /expires in 15 minutes/);
    globalThis.fetch = async () => new Response(null, { status: 500 });

    await assert.rejects(
      sendAccountEmail("reader@example.test", "http://localhost", "reset"),
      /delivery failed/,
    );
  } finally {
    globalThis.fetch = previousFetch;

    if (previousKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previousKey;
    }

    if (previousFrom === undefined) {
      delete process.env.EMAIL_FROM;
    } else {
      process.env.EMAIL_FROM = previousFrom;
    }
  }
});
