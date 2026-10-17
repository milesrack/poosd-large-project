import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

let source: string;
let exists = true;

try {
  source = await readFile(".env", "utf8");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }

  exists = false;
  source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
}

const values = parseEnv(source);
let changed = !exists;

for (const [key, value] of Object.entries({
  BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
  BETTER_AUTH_URL: "http://localhost:3000",
})) {
  if (values[key]?.trim()) {
    continue;
  }

  const line = new RegExp(`^${key}=.*$`, "gm");

  source = line.test(source)
    ? source.replace(line, () => `${key}=${value}`)
    : `${source.trimEnd()}\n${key}=${value}\n`;

  changed = true;
}

if (changed) {
  await writeFile(".env", source, { flag: exists ? "w" : "wx", mode: 0o600 });
}

await chmod(".env", 0o600);

console.log(
  changed
    ? "Local authentication configuration ready"
    : "Existing authentication configuration preserved",
);
