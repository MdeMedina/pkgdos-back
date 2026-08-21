import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { env } from "./config/env.js";
import apiRouter from "./routes/index.js";
import { prisma } from "./config/database.js";
import {
  requireAuthOrN8N,
  resolveBrandContext,
  isBrandMember,
  AuthenticatedRequest,
} from "./middlewares/auth.middleware.js";

const app = express();

// Trust reverse proxy to correctly identify protocols (http vs https) behind proxy/Cloudflare
app.set("trust proxy", true);

// CORS allowlist: only our own front-end origins may send credentialed/authorized
// requests. Wildcard "*" is unsafe for an API that accepts Authorization / X-N8N-Token.
const allowedOrigins = Array.from(
  new Set([env.APP_BASE_URL, "https://os.pkgdgroup.com"].filter(Boolean)),
);
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (no Origin header): server-to-server, n8n, curl.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-N8N-Token"],
  })
);

// Capturamos el cuerpo crudo (rawBody) al parsear JSON: el webhook de Dropbox se firma con
// HMAC-SHA256 sobre los bytes exactos del body, así que necesitamos verificar contra el
// original, no contra el JSON re-serializado. Es un no-op para el resto de rutas.
app.use(
  express.json({
    limit: "2mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Authenticated file serving. The old `express.static` exposed every uploaded
// document with no auth at all. Now: an operator JWT or the n8n service token is
// required, and an operator may only read a file whose brand they belong to.
// The n8n token is accepted because the ingest pipeline fetches these URLs
// (it must send `x-n8n-token` when doing so).
app.get("/uploads/:filename", requireAuthOrN8N, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // block path traversal
    const filePath = path.join(env.UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found" });
    }

    // Enforce brand membership for operators when the file maps to a branded Drive
    // file/version. The n8n service token bypasses (trusted ingest service).
    const authReq = req as AuthenticatedRequest;
    if (authReq.user) {
      const url = `/uploads/${filename}`;
      let brandId: string | null | undefined;
      const dbFile = await prisma.driveFile.findFirst({ where: { url }, select: { brand_id: true } });
      if (dbFile) {
        brandId = dbFile.brand_id;
      } else {
        const version = await prisma.driveFileVersion.findFirst({
          where: { url },
          select: { file: { select: { brand_id: true } } },
        });
        if (version) brandId = version.file?.brand_id ?? null;
      }
      // brandId === undefined => not a known Drive file (e.g. knowledge source doc);
      // served to any authenticated operator. A branded Drive file is gated.
      if (brandId !== undefined) {
        const ctx = await resolveBrandContext(req);
        if (ctx && !isBrandMember(ctx, brandId)) {
          return res.status(403).json({ message: "You are not a member of this file's brand" });
        }
      }
    }

    return res.sendFile(filePath);
  } catch (error) {
    console.error("Serve upload error:", error);
    return res.status(500).json({ message: "Failed to serve file" });
  }
});

// Root API Router
app.use("/api", apiRouter);

// Fallback health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date() });
});

// Error handling middleware. Never leak stack traces or internal error detail to
// the client: log the full error server-side, respond with a generic message.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Global uncaught error:", err);
  const status = err.status || 500;
  // For 4xx we may echo a safe, caller-facing message; for 5xx stay generic.
  const clientMessage =
    status < 500 && err.message ? err.message : "An unexpected error occurred on the PKGD OS Backend";
  return res.status(status).json({ message: clientMessage });
});

app.listen(env.PORT, () => {
  console.log(`=========================================`);
  console.log(` PKGD OS Backend (Hito 1) is active!`);
  console.log(` Port: ${env.PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`=========================================`);
});
