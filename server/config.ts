import { isIP } from "node:net";

export function readConfig(env = process.env) {
  const url = new URL(env.BETTER_AUTH_URL ?? "http://localhost:3000");

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw Error("BETTER_AUTH_URL must be an HTTP(S) origin");
  }

  const publicDeployment = env.PUBLIC_DEPLOYMENT === "true";

  if (publicDeployment) {
    if (
      url.protocol !== "https:" ||
      url.port ||
      !url.hostname.includes(".") ||
      isIP(url.hostname) ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local")
    ) {
      throw Error(
        "Public deployment requires BETTER_AUTH_URL on an HTTPS domain",
      );
    }

    if ((env.BETTER_AUTH_SECRET ?? "").length < 32) {
      throw Error(
        "Public deployment requires a stable BETTER_AUTH_SECRET of at least 32 characters",
      );
    }

    if (
      !env.RESEND_API_KEY?.trim() ||
      !env.EMAIL_FROM?.trim() ||
      /@[^>\s]*\.local>?$/.test(env.EMAIL_FROM)
    ) {
      throw Error(
        "Public deployment requires RESEND_API_KEY and EMAIL_FROM on a verified sender domain",
      );
    }
  }

  const origins = publicDeployment
    ? [url.origin]
    : [
        ...new Set([
          url.origin,
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
        ]),
      ];

  return { origin: url.origin, publicDeployment, origins };
}
