import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../shared/password-policy.ts";
import { passwordStrength } from "../shared/password-strength.ts";

// New credentials only. Existing passwords must remain usable for login.
export async function checkNewPassword(
  password: unknown,
  request: typeof fetch = fetch,
) {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return;
  }

  const normalised = password.normalize("NFKC");

  if (passwordStrength(normalised) < 2) {
    throw new APIError("BAD_REQUEST", {
      code: "PASSWORD_TOO_WEAK",
      message:
        "This password is too predictable. Try a longer phrase with unrelated words.",
    });
  }

  const hash = createHash("sha1")
    .update(normalised)
    .digest("hex")
    .toUpperCase();
  let lines: string[];

  try {
    const response = await request(
      `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
      {
        headers: {
          "Add-Padding": "true",
          "User-Agent": "Zetafly password screening",
        },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      throw Error("Unavailable");
    }

    lines = (await response.text()).trim().split(/\r?\n/);

    if (
      !lines.length ||
      lines.some((line) => !/^([A-F0-9]{35}):\d+$/i.test(line))
    ) {
      throw Error("Invalid response");
    }
  } catch {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "PASSWORD_CHECK_UNAVAILABLE",
      message:
        "Password checking is temporarily unavailable. Please try again.",
    });
  }

  if (
    lines.some(
      (line) =>
        line.slice(0, 35).toUpperCase() === hash.slice(5) &&
        Number(line.slice(36)) > 0,
    )
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "PASSWORD_COMPROMISED",
      message:
        "This password appears in known data breaches. Choose a different password.",
    });
  }
}
