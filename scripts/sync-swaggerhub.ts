import { readFile } from "node:fs/promises";
import { apiContract } from "./api-contract.ts";

const owner = process.env.SWAGGERHUB_OWNER;
const key = process.env.SWAGGERHUB_API_KEY;

if (!owner || !/^[\w-]+$/.test(owner) || !key) {
  throw Error("Set SWAGGERHUB_OWNER and SWAGGERHUB_API_KEY before syncing");
}

const { document } = await apiContract();
const url = new URL(`https://api.swaggerhub.com/apis/${owner}/zetafly`);

url.searchParams.set("version", document.info.version);

url.searchParams.set("isPrivate", "true");

const response = await fetch(url, {
  method: "POST",
  headers: { Authorization: key, "Content-Type": "application/yaml" },
  body: await readFile("openapi.yaml", "utf8"),
  signal: AbortSignal.timeout(30_000),
});

if (!response.ok) {
  throw Error(`SwaggerHub sync failed: HTTP ${response.status}`);
}

console.log(`Synced private Zetafly API ${document.info.version}`);
