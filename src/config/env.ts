import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  JWT_SECRET: process.env.JWT_SECRET || "supersecretkeyfortheoracleworkspace",
  N8N_SECRET_TOKEN: process.env.N8N_SECRET_TOKEN || "n8n_secure_secret_token_123",
  N8N_INTAKE_WEBHOOK: process.env.N8N_INTAKE_WEBHOOK || "https://n8n.pkgdgroup.com/webhook/pkgd/intake",
  DATABASE_URL: process.env.DATABASE_URL || "",
};

