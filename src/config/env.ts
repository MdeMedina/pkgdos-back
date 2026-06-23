import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  JWT_SECRET: process.env.JWT_SECRET || "supersecretkeyfortheoracleworkspace",
  N8N_SECRET_TOKEN: process.env.N8N_SECRET_TOKEN || "n8n_secure_secret_token_123",
  N8N_BASE_URL: process.env.N8N_BASE_URL || "https://n8n.pkgdgroup.com",
  DATABASE_URL: process.env.DATABASE_URL || "",
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads"),
};

