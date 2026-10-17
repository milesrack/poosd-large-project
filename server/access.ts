import type { IncomingHttpHeaders } from "node:http";
import type { CookieOptions } from "express";
import { type Db, ObjectId } from "mongodb";

export const ACCESS_COOKIE = "zetafly_access";
export const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: (process.env.BETTER_AUTH_URL ?? "").startsWith("https:"),
  path: "/",
};

type HeaderRequest = { headers: IncomingHttpHeaders };

type JwtVerifier = {
  api: {
    verifyJWT: (request: {
      body: { token: string };
    }) => Promise<{ payload: unknown }>;
  };
};

function readToken(req: HeaderRequest) {
  const bearer = req.headers.authorization?.match(/^Bearer ([\w.-]+)$/)?.[1];

  if (bearer) {
    return bearer;
  }

  const cookie = req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${ACCESS_COOKIE}=`));

  if (!cookie) {
    return null;
  }

  try {
    return decodeURIComponent(cookie.slice(ACCESS_COOKIE.length + 1));
  } catch {
    return null;
  }
}

export function accessVerifier(auth: JwtVerifier, db: Db) {
  return async (req: HeaderRequest) => {
    const token = readToken(req);

    if (!token || token.length > 4096) {
      return null;
    }

    try {
      const { payload } = await auth.api.verifyJWT({ body: { token } });

      if (
        !payload ||
        typeof payload !== "object" ||
        !("sid" in payload) ||
        !("sub" in payload) ||
        typeof payload.sid !== "string" ||
        typeof payload.sub !== "string" ||
        !ObjectId.isValid(payload.sid) ||
        !ObjectId.isValid(payload.sub)
      ) {
        return null;
      }

      const session = await db.collection("session").findOne({
        _id: new ObjectId(payload.sid),
        expiresAt: { $gt: new Date() },
      });

      if (!session || String(session.userId) !== payload.sub) {
        return null;
      }

      const user = await db
        .collection("user")
        .findOne(
          { _id: new ObjectId(payload.sub), emailVerified: true },
          { projection: { _id: 1 } },
        );

      if (!user) {
        return null;
      }

      return { session: { id: payload.sid }, user: { id: payload.sub } };
    } catch {
      return null;
    }
  };
}
