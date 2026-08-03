import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  JWT_SECRET: process.env.JWT_SECRET || "supersecretkeyfortheoracleworkspace",
  N8N_SECRET_TOKEN: process.env.N8N_SECRET_TOKEN || "n8n_secure_secret_token_123",
  N8N_BASE_URL: process.env.N8N_BASE_URL || "https://n8n.pkgdgroup.com",
  APP_BASE_URL: process.env.APP_BASE_URL || "https://os.pkgdgroup.com",
  DATABASE_URL: process.env.DATABASE_URL || "",
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads"),
  // Apache Tika, reused from the ingest pipeline to render document previews
  // (docx/xlsx/pptx/odt/rtf/…). Published on loopback by the n8n compose project.
  TIKA_URL: process.env.TIKA_URL || "http://127.0.0.1:9998",
  // Quincenal Pulse — backend de datos propio (Express + SQLite + Windsor.ai),
  // publicado en loopback por su compose. PKGD OS lo consume vía /api/pulse/*.
  PULSE_API_URL: process.env.PULSE_API_URL || "http://127.0.0.1:4000",
  PULSE_API_KEY: process.env.PULSE_API_KEY || "",
};

