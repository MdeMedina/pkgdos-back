import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import apiRouter from "./routes/index.js";

const app = express();

// Trust reverse proxy to correctly identify protocols (http vs https) behind proxy/Cloudflare
app.set("trust proxy", true);

// Configure CORS to allow frontend calls
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-N8N-Token"],
  })
);

// Capturamos el cuerpo crudo (rawBody) al parsear JSON: el webhook de Dropbox se firma con
// HMAC-SHA256 sobre los bytes exactos del body, así que necesitamos verificar contra el
// original, no contra el JSON re-serializado. Es un no-op para el resto de rutas.
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// Serve uploads folder static files (for document downloads)
app.use("/uploads", express.static(env.UPLOADS_DIR));

// Root API Router
app.use("/api", apiRouter);

// Fallback health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date() });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Global uncaught error:", err);
  const status = err.status || 500;
  return res.status(status).json({
    message: err.message || "An unexpected error occurred on the PKGD OS Backend",
  });
});

app.listen(env.PORT, () => {
  console.log(`=========================================`);
  console.log(` PKGD OS Backend (Hito 1) is active!`);
  console.log(` Port: ${env.PORT}`);
  console.log(` Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`=========================================`);
});
