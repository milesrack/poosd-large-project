import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiContract } from "./api-contract.ts";
import type {
  MailMessage,
  MailSearch,
  Profile,
  RequestOptions,
} from "./verification-types.ts";

const contract = await apiContract();
const base = process.env.APP_URL ?? "http://localhost:3000";
const suffix = randomBytes(6).toString("hex");
const password = randomBytes(24).toString("base64url");
const uploaded: { instance: ReturnType<typeof client>; id: string }[] = [];

function client() {
  const jar = new Map<string, string>();

  return {
    cookie: () => [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
    async send(
      path: string,
      {
        method = "GET",
        json,
        body,
        headers = {},
        status = 200,
      }: RequestOptions = {},
    ) {
      const response = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: {
          Origin: base,
          Cookie: this.cookie(),
          ...(json ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: json ? JSON.stringify(json) : body,
      });

      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0];
        const index = pair.indexOf("=");
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      }

      assert.equal(response.status, status, `${method} ${path.split("?")[0]}`);

      return response;
    },
  };
}

async function account(label: string) {
  const instance = client();
  const email = `weights-${label}-${suffix}@example.test`;

  await instance.send("/api/auth/sign-up/email", {
    method: "POST",
    json: {
      name: `Search QA ${label}`,
      email,
      password,
      callbackURL: `${base}/`,
    },
  });

  const inbox = process.env.MAILPIT_URL ?? "http://localhost:8025";
  let link: URL | undefined;

  for (let count = 0; count < 20 && !link; count++) {
    const results = (await (
      await fetch(
        `${inbox}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      )
    ).json()) as MailSearch;
    const summary = results.messages?.find(
      (message) => message.Subject === "Verify your Zetafly email",
    );

    if (summary) {
      const message = (await (
        await fetch(`${inbox}/api/v1/message/${summary.ID}`)
      ).json()) as MailMessage;

      link = new URL(message.Text.match(/https?:\/\/[^\s]+/)![0]);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  assert.ok(link, "Verification email missing");
  await instance.send(link.pathname + link.search, { status: 302 });
  await instance.send("/api/access", { method: "POST" });

  return { instance, email };
}

let alice: Awaited<ReturnType<typeof account>> | undefined;
let bob: Awaited<ReturnType<typeof account>> | undefined;

try {
  assert.ok(
    (
      (await (await fetch(`${base}/api/public-config`)).json()) as {
        localInbox: string | null;
      }
    ).localInbox,
    "Use local Mailpit for this fixture",
  );

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  await contract.response("/api/health", health);
  const anonymous = await fetch(`${base}/api/weights`);
  assert.equal(anonymous.status, 401);
  await contract.response("/api/weights", anonymous);
  alice = await account("alice");
  bob = await account("bob");
  const bytes = await readFile("models/default/weights.npz");

  async function upload(instance: ReturnType<typeof client>, name: string) {
    const profile = (await (
      await instance.send("/api/weights", {
        method: "POST",
        body: bytes,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(`${name}.npz`),
        },
        status: 201,
      })
    ).json()) as Profile;

    uploaded.push({ instance, id: profile.id });

    return profile;
  }

  const first = await upload(alice.instance, "Training v2");
  const second = await upload(alice.instance, "Retrained addition");
  const literal = await upload(alice.instance, "Draft [v2]");
  await upload(bob.instance, "Training private");

  const search = async (instance: ReturnType<typeof client>, q: string) =>
    (await contract.response(
      "/api/weights",
      await instance.send(`/api/weights?q=${encodeURIComponent(q)}`),
    )) as Profile[];
  const token = alice.instance
    .cookie()
    .match(/(?:^|; )zetafly_access=([^;]+)/)?.[1];

  assert.ok(token, "JWT access cookie missing");

  const bearer = await fetch(`${base}/api/weights?q=TrAiN`, {
    headers: { Authorization: `Bearer ${decodeURIComponent(token)}` },
  });

  assert.equal(bearer.status, 200);

  const bearerProfiles = (await contract.response(
    "/api/weights",
    bearer,
  )) as Profile[];

  assert.deepEqual(
    new Set(bearerProfiles.map((profile) => profile.id)),
    new Set([first.id, second.id]),
  );

  await contract.response(
    "/api/weights",
    await alice.instance.send(`/api/weights?q=${"x".repeat(100)}`),
  );

  await contract.response(
    "/api/weights",
    await alice.instance.send(`/api/weights?q=${"x".repeat(101)}`, {
      status: 400,
    }),
  );

  const forged = await fetch(`${base}/api/weights`, {
    headers: { Authorization: "Bearer invalid" },
  });

  assert.equal(forged.status, 401);
  await contract.response("/api/weights", forged);

  assert.deepEqual(
    new Set((await search(alice.instance, " TrAiN ")).map((row) => row.id)),
    new Set([first.id, second.id]),
  );

  assert.deepEqual(
    (await search(alice.instance, "[v2]")).map((row) => row.id),
    [literal.id],
  );

  for (const query of [".*", "^", "private", "missing-profile"]) {
    assert.deepEqual(await search(alice.instance, query), []);
  }

  assert.equal((await search(bob.instance, "train")).length, 1);

  assert.deepEqual(
    (await search(alice.instance, "FaUl")).map((row) => row.id),
    ["published"],
  );

  await alice.instance.send(`/api/weights?q=${"x".repeat(101)}`, {
    status: 400,
  });

  await alice.instance.send("/api/weights?q=a&q=b", { status: 400 });
  await client().send("/api/weights?q=train", { status: 401 });

  console.log("Weight search and account isolation passed");
} finally {
  for (const { instance, id } of uploaded) {
    await instance.send(`/api/weights/${id}`, { method: "DELETE" });
  }

  if (alice) {
    await alice.instance.send("/api/auth/sign-out", { method: "POST" });
  }

  if (bob) {
    await bob.instance.send("/api/auth/sign-out", { method: "POST" });
  }
}
