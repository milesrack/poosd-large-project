import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { type ErrorRequestHandler, type Request } from "express";
import { MongoClient } from "mongodb";
import { WebSocket, WebSocketServer } from "ws";
import type { LabPacket } from "../shared/contracts.ts";
import { ACCESS_COOKIE, accessVerifier, cookieOptions } from "./access.ts";
import { createAuth } from "./auth.ts";
import { readConfig } from "./config.ts";
import { prepareDatabase } from "./database.ts";
import { asError } from "./errors.ts";
import { Laboratory } from "./laboratory.ts";
import { securityHeaders } from "./security.ts";
import { DEFAULTS, parseSettings } from "./settings.ts";
import { Weights } from "./weights.ts";

declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

declare module "ws" {
  interface WebSocket {
    userId?: string;
    sessionId?: string;
    authHeaders?: IncomingHttpHeaders;
  }
}

const config = readConfig();
const client = new MongoClient(
  process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 5000 },
);

await client.connect();

const db = client.db(process.env.MONGODB_DATABASE?.trim() || "zetafly");
await prepareDatabase(db);

const auth = createAuth(db);
const weights = new Weights(db);

const app = express();

app.disable("x-powered-by");

app.set("trust proxy", config.publicDeployment ? 1 : false);

app.use(securityHeaders(config.publicDeployment));

app.use((req, _res, next) => {
  req.headers["x-zetafly-client-ip"] = req.ip;
  next();
});

const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const broadcast = (ownerId: string, packet: LabPacket) => {
  const body = JSON.stringify(packet);

  for (const socket of sockets.clients) {
    if (
      socket.userId === ownerId &&
      socket.readyState === WebSocket.OPEN &&
      socket.bufferedAmount < 2_000_000
    ) {
      socket.send(body);
    }
  }
};
const laboratory = new Laboratory(db, broadcast, weights);
const identify = accessVerifier(auth, db);
const cookieSession = (req: Request) =>
  auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

app.post("/api/auth/sign-out", async (req, res, next) => {
  const identity = await cookieSession(req);
  res.clearCookie(ACCESS_COOKIE, cookieOptions);

  if (identity) {
    res.once("finish", () => {
      if (res.statusCode < 300) {
        for (const socket of sockets.clients) {
          if (socket.sessionId === identity.session.id) {
            socket.close(1000);
          }
        }

        laboratory.stop(identity.user.id).catch(() => {});
      }
    });
  }

  next();
});

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json({ limit: "8kb" }));

const origins = new Set(config.origins);

app.use("/api", (req, res, next) => {
  const origin = req.get("origin");

  if (origin && !origins.has(origin)) {
    return res.status(403).json({ error: "Origin rejected" });
  }

  next();
});

app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.get("/api/public-config", (_req, res) =>
  res.json({
    localInbox: process.env.RESEND_API_KEY ? null : "http://localhost:8025",
  }),
);

app.post("/api/access", async (req, res) => {
  const identity = await cookieSession(req);

  if (!identity) {
    return res.status(401).json({ error: "Log in to use Zetafly" });
  }

  if (!identity.user.emailVerified) {
    return res
      .status(403)
      .json({ error: "Verify your email before continuing" });
  }

  const { token } = await auth.api.getToken({
    headers: fromNodeHeaders(req.headers),
  });

  res.cookie(ACCESS_COOKIE, token, { ...cookieOptions, maxAge: 300000 });
  res.json({ ok: true });
});

app.use("/api", async (req, res, next) => {
  const identity = await identify(req);

  if (!identity) {
    return res.status(401).json({ error: "Log in to use Zetafly" });
  }

  req.userId = identity.user.id;
  next();
});

app.get("/api/preferences", async (req, res) => {
  const previous =
    (await db.collection("preferences").findOne({ ownerId: req.userId }))
      ?.settings ?? {};
  let settings = { ...DEFAULTS };

  try {
    settings = parseSettings(
      Object.fromEntries(
        Object.keys(DEFAULTS)
          .filter((key) => Object.hasOwn(previous, key))
          .map((key) => [key, previous[key]]),
      ),
    );
  } catch {
    settings = { ...DEFAULTS };
  }

  if (settings.profileId !== "published") {
    const profile = await weights.collection.findOne({
      ownerId: req.userId,
      id: settings.profileId,
      checkpointFormat: "sequence-npz-v1",
    });

    if (!profile) {
      settings.profileId = "published";
    }
  }

  res.json(settings);
});

app.put("/api/preferences", async (req, res) => {
  const settings = parseSettings(req.body);
  await weights.get(req.userId, settings.profileId);

  await db
    .collection("preferences")
    .updateOne(
      { ownerId: req.userId },
      { $set: { settings, updatedAt: new Date() } },
      { upsert: true },
    );

  res.json(settings);
});

app.get("/api/weights", async (req, res) =>
  res.json(await weights.list(req.userId, req.query.q ?? "")),
);

app.post("/api/weights", async (req, res) => {
  if (!req.is("application/octet-stream")) {
    return res
      .status(415)
      .json({ error: "Upload NPZ weights as application/octet-stream" });
  }

  res.status(201).json(await weights.upload(req, req.userId));
});

app.get("/api/weights/:id/file", async (req, res) =>
  weights.download(await weights.get(req.userId, req.params.id), res),
);

app.delete("/api/weights/:id", async (req, res) => {
  const current = laboratory.current;

  if (
    current?.ownerId === req.userId &&
    (current.session.running || current.session.previewing)
  ) {
    return res
      .status(409)
      .json({ error: "Stop the run before removing weights" });
  }

  await weights.remove(req.userId, req.params.id);

  await db
    .collection("preferences")
    .updateOne(
      { ownerId: req.userId, "settings.profileId": req.params.id },
      { $set: { "settings.profileId": "published" } },
    );

  res.json({ ok: true });
});

app.get("/api/runs", async (req, res) =>
  res.json(
    await db
      .collection("runs")
      .find({ ownerId: req.userId }, { projection: { events: 0 } })
      .sort({ startedAt: -1 })
      .limit(20)
      .toArray(),
  ),
);

app.get("/api/runs/:id", async (req, res) => {
  const run = await db
    .collection("runs")
    .findOne({ id: req.params.id, ownerId: req.userId });

  if (!run) {
    return res.status(404).json({ error: "Run not found" });
  }

  res.json(run);
});

app.post("/api/preview", async (req, res) => {
  const session = await laboratory.claim(req.userId);
  await session.preview();
  res.json({ ok: true });
});

app.post("/api/start", async (req, res) => {
  const settings = parseSettings(req.body);
  await laboratory.start(req.userId, settings);
  res.status(202).json({ status: "loading" });
});

app.post("/api/stop", async (req, res) => {
  await laboratory.stop(req.userId);
  res.json({ status: laboratory.state(req.userId).status });
});

app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown endpoint" }),
);

app.use(express.static("web/dist"));

const handleError: ErrorRequestHandler = (value: unknown, _req, res, _next) => {
  const error = asError(value);

  if (res.headersSent) {
    res.destroy();

    return;
  }

  const status = error.status ?? (error instanceof SyntaxError ? 400 : 500);

  if (status >= 500) {
    console.error(error.message);
  }

  res.status(status).json({
    error:
      status === 500 ? "The request could not be completed" : error.message,
  });
};

app.use(handleError);

server.on("upgrade", async (req, socket, head) => {
  try {
    if (req.url !== "/live" || !origins.has(req.headers.origin ?? "")) {
      socket.destroy();

      return;
    }

    const identity = await identify(req);

    if (!identity) {
      socket.destroy();

      return;
    }

    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = identity.user.id;
      ws.sessionId = identity.session.id;
      ws.authHeaders = req.headers;

      ws.send(
        JSON.stringify({
          kind: "state",
          ...laboratory.state(ws.userId),
          serverTime: Date.now(),
        }),
      );

      const current = laboratory.current;

      if (current?.ownerId === ws.userId && current.session.screen) {
        ws.send(
          JSON.stringify({
            kind: "screen",
            png: current.session.screen,
            runId: current.session.state.runId,
          }),
        );
      }
    });
  } catch {
    socket.destroy();
  }
});

const recheck = setInterval(() => {
  for (const socket of sockets.clients) {
    identify({ headers: socket.authHeaders ?? {} })
      .then((identity) => {
        if (!identity || identity.session.id !== socket.sessionId) {
          socket.close(1000);
        }
      })
      .catch(() => socket.close(1011));
  }
}, 30000);

server.listen(
  Number(process.env.PORT ?? 3000),
  process.env.HOST ?? "127.0.0.1",
  () => console.log("Zetafly: http://localhost:3000"),
);

async function shutdown() {
  clearInterval(recheck);
  await laboratory.close();

  for (const socket of sockets.clients) {
    socket.close();
  }

  server.close();
  await client.close();
}

process.on("SIGINT", () => shutdown().then(() => process.exit(0)));

process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
