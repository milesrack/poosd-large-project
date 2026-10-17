import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

const script = resolve("scripts/setup-env.ts");

function setup(cwd: string) {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);

  return result.stdout;
}

test("setup creates a private complete local environment and preserves it on rerun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zetafly-setup-"));

  try {
    setup(directory);
    const source = await readFile(join(directory, ".env"), "utf8");
    const values = parseEnv(source);
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 32);
    assert.equal(values.BETTER_AUTH_URL, "http://localhost:3000");
    assert.equal(values.RESEND_API_KEY, "");
    assert.ok(values.EMAIL_FROM!.includes("@zetafly.local"));
    assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
    setup(directory);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup repairs copied blank auth fields while preserving configured values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zetafly-setup-"));

  try {
    await writeFile(
      join(directory, ".env"),
      'BETTER_AUTH_SECRET=""\nBETTER_AUTH_URL=https://zetafly.example\nRESEND_API_KEY=test-placeholder\nEMAIL_FROM=Zetafly <mail@zetafly.example>\nCUSTOM_VALUE=preserve\n',
    );

    setup(directory);
    const source = await readFile(join(directory, ".env"), "utf8");
    const values = parseEnv(source);
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 32);
    assert.equal(values.BETTER_AUTH_URL, "https://zetafly.example");
    assert.equal(values.RESEND_API_KEY, "test-placeholder");
    assert.equal(values.CUSTOM_VALUE, "preserve");
    setup(directory);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
