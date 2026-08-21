import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

// ── Fail-fast secret validation ──────────────────────────────────────────────
// Secrets must come from the environment (or a vault). We refuse to boot with a
// missing secret or with a known public default, so a misconfigured deploy fails
// loudly at startup instead of silently accepting forgeable tokens.
// NOTE: we only validate here — the ORCHESTRATOR is responsible for setting/rotating
// the real values on the server. We never hardcode a fallback value.
const KNOWN_PUBLIC_DEFAULTS: Record<string, string> = {
  JWT_SECRET: "supersecretkeyfortheoracleworkspace",
  N8N_SECRET_TOKEN: "n8n_secure_secret_token_123",
};

/** Read a required secret; abort the process if it is missing, a known public
 *  default, or (when `minLen` is given) shorter than the minimum length. */
function requireSecret(name: string, minLen = 0): string {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: Required environment variable "${name}" is not set. Refusing to start.`);
    process.exit(1);
  }
  if (KNOWN_PUBLIC_DEFAULTS[name] && value === KNOWN_PUBLIC_DEFAULTS[name]) {
    console.error(`FATAL: "${name}" is set to a known public default value. Set a fresh secret. Refusing to start.`);
    process.exit(1);
  }
  if (minLen > 0 && value.length < minLen) {
    console.error(`FATAL: "${name}" must be at least ${minLen} characters long. Refusing to start.`);
    process.exit(1);
  }
  return value;
}

export const env = {
  PORT: parseInt(process.env.PORT || "5000", 10),
  JWT_SECRET: requireSecret("JWT_SECRET", 32),
  N8N_SECRET_TOKEN: requireSecret("N8N_SECRET_TOKEN", 32),
  N8N_BASE_URL: process.env.N8N_BASE_URL || "https://n8n.pkgdgroup.com",
  APP_BASE_URL: process.env.APP_BASE_URL || "https://os.pkgdgroup.com",
  DATABASE_URL: requireSecret("DATABASE_URL"),
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads"),
  // Apache Tika, reused from the ingest pipeline to render document previews
  // (docx/xlsx/pptx/odt/rtf/…). Published on loopback by the n8n compose project.
  TIKA_URL: process.env.TIKA_URL || "http://127.0.0.1:9998",
  // Quincenal Pulse — backend de datos propio (Express + SQLite + Windsor.ai),
  // publicado en loopback por su compose. PKGD OS lo consume vía /api/pulse/*.
  PULSE_API_URL: process.env.PULSE_API_URL || "http://127.0.0.1:4000",
  PULSE_API_KEY: process.env.PULSE_API_KEY || "",
  // ── Dropbox (espejo en vivo del Drive) ──────────────────────────────────────
  // App Scoped de solo lectura (files.metadata.read + files.content.read). El refresh
  // token es permanente; el access token se renueva solo. El APP_SECRET además firma
  // (HMAC-SHA256) los webhooks entrantes, así que sirve de secreto de verificación.
  DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY || "",
  DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET || "",
  DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN || "",
  // Carpeta espejada (ruta API, ya enraizada en el team space): "/EXTERNAL DOWNLOADS".
  DROPBOX_ROOT_PATH: process.env.DROPBOX_ROOT_PATH || "/EXTERNAL DOWNLOADS",
};

/** ¿Está configurada la integración de Dropbox? (evita arrancar sync sin credenciales) */
export const dropboxEnabled = () =>
  Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET && env.DROPBOX_REFRESH_TOKEN);

