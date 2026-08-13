import crypto from "node:crypto";
import path from "node:path";
import { env } from "../config/env.js";

/**
 * Cliente mínimo de la API de Dropbox para el espejo en vivo del Drive.
 *
 * Diseño:
 *  - SOLO LECTURA. Los scopes de la app son files.metadata.read + files.content.read;
 *    aquí no hay ninguna llamada que escriba/mueva/borre en Dropbox.
 *  - El refresh token (permanente) se cambia por un access token de corta vida que
 *    cacheamos en memoria y renovamos solo cuando está por expirar.
 *  - "Enlace invisible": get_temporary_link devuelve una URL de descarga directa de
 *    Dropbox (válida ~4h). El usuario nunca la ve: nuestro backend la genera fresca y
 *    hace 302 en cada acceso, así nada expira de cara al usuario.
 */

const OAUTH_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

export class DropboxError extends Error {
  status: number;
  /** true cuando el fallo es de Dropbox/red (caída del "puente"), no un bug nuestro. */
  upstream: boolean;
  constructor(message: string, status = 502, upstream = true) {
    super(message);
    this.status = status;
    this.upstream = upstream;
  }
}

// ── Access token: cache en memoria con auto-refresh ─────────────────────────────
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Renueva con 5 min de colchón antes de expirar.
  if (cachedToken && cachedToken.expiresAt - 300_000 > Date.now()) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN,
    client_id: env.DROPBOX_APP_KEY,
    client_secret: env.DROPBOX_APP_SECRET,
  });

  let res: globalThis.Response;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new DropboxError(`No se pudo contactar a Dropbox (OAuth): ${err?.message ?? "red"}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 400 en el refresh suele significar token revocado / permisos expirados del autorizador.
    throw new DropboxError(
      `Dropbox rechazó el refresh token (${res.status}). Puede que el usuario que autorizó la conexión haya perdido permisos. ${text}`,
      res.status === 400 ? 401 : 502
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

/** Fuerza descartar el token cacheado (p.ej. tras un 401 en una llamada normal). */
function invalidateToken() {
  cachedToken = null;
}

// ── Llamada RPC genérica (endpoints /2/... que reciben y devuelven JSON) ─────────
async function rpc<T>(endpoint: string, args: unknown, retryOn401 = true): Promise<T> {
  const token = await getAccessToken();
  let res: globalThis.Response;
  try {
    res = await fetch(`${RPC_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new DropboxError(`Dropbox no responde (${endpoint}): ${err?.message ?? "red"}`);
  }

  if (res.status === 401 && retryOn401) {
    invalidateToken();
    return rpc<T>(endpoint, args, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DropboxError(`Dropbox ${endpoint} devolvió ${res.status}: ${text}`, res.status);
  }
  return (await res.json()) as T;
}

// ── Tipos que usamos del metadata de Dropbox ────────────────────────────────────
export type DbxEntry =
  | {
      ".tag": "folder";
      id: string;
      name: string;
      path_display: string;
      path_lower: string;
    }
  | {
      ".tag": "file";
      id: string;
      name: string;
      path_display: string;
      path_lower: string;
      rev: string;
      size: number;
      content_hash?: string;
    }
  | {
      ".tag": "deleted";
      name: string;
      path_display?: string;
      path_lower: string;
    };

interface ListFolderResult {
  entries: DbxEntry[];
  cursor: string;
  has_more: boolean;
}

/**
 * Listado inicial recursivo de una carpeta. Devuelve TODAS las entradas (paginando
 * internamente) y el cursor final para pedir solo cambios a partir de ahí.
 */
export async function listFolderAll(rootPath: string): Promise<{ entries: DbxEntry[]; cursor: string }> {
  const all: DbxEntry[] = [];
  let page = await rpc<ListFolderResult>("/files/list_folder", {
    path: rootPath,
    recursive: true,
    include_deleted: false,
    limit: 2000,
  });
  all.push(...page.entries);
  while (page.has_more) {
    page = await rpc<ListFolderResult>("/files/list_folder/continue", { cursor: page.cursor });
    all.push(...page.entries);
  }
  return { entries: all, cursor: page.cursor };
}

/** Trae los cambios (delta) desde un cursor. Puede paginar varias veces. */
export async function listFolderDelta(
  cursor: string
): Promise<{ entries: DbxEntry[]; cursor: string }> {
  const all: DbxEntry[] = [];
  let page = await rpc<ListFolderResult>("/files/list_folder/continue", { cursor });
  all.push(...page.entries);
  while (page.has_more) {
    page = await rpc<ListFolderResult>("/files/list_folder/continue", { cursor: page.cursor });
    all.push(...page.entries);
  }
  return { entries: all, cursor: page.cursor };
}

/** Enlace temporal de descarga directa (válido ~4h). El "enlace invisible" del usuario. */
export async function getTemporaryLink(pathOrId: string): Promise<string> {
  const r = await rpc<{ link: string }>("/files/get_temporary_link", { path: pathOrId });
  return r.link;
}

/**
 * Descarga los bytes de un archivo (para indexado efímero: Tika/preview). Se usa el
 * endpoint de contenido; el archivo NO se persiste en nuestros servidores.
 */
export async function download(pathOrId: string): Promise<{ buffer: Buffer; name: string }> {
  const token = await getAccessToken();
  let res: globalThis.Response;
  try {
    res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: pathOrId }),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: any) {
    throw new DropboxError(`Dropbox no responde (download): ${err?.message ?? "red"}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DropboxError(`Dropbox download devolvió ${res.status}: ${text}`, res.status);
  }
  const apiResult = res.headers.get("dropbox-api-result");
  const name = apiResult ? (JSON.parse(apiResult).name as string) : path.basename(pathOrId);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, name };
}

/**
 * Miniatura JPEG generada por Dropbox (≤2048px). Ideal para la descripción por visión:
 * pesa ~1MB aunque el original sean 40MB, así el modelo la procesa sin reventar el tope de
 * tamaño. El binario original NO se descarga. Dropbox genera el thumbnail sin importar el
 * peso del archivo fuente.
 */
export async function getThumbnail(pathOrId: string): Promise<Buffer> {
  const token = await getAccessToken();
  const arg = {
    resource: { ".tag": "path", path: pathOrId },
    format: "jpeg",
    size: "w2048h1536",
    mode: "fitone_bestfit",
  };
  let res: globalThis.Response;
  try {
    res = await fetch(`${CONTENT_BASE}/files/get_thumbnail_v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify(arg) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: any) {
    throw new DropboxError(`Dropbox no responde (thumbnail): ${err?.message ?? "red"}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DropboxError(`Dropbox get_thumbnail devolvió ${res.status}: ${text}`, res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verifica la firma del webhook: HMAC-SHA256 del cuerpo crudo con el APP_SECRET.
 * Comparación en tiempo constante para no filtrar información por timing.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): boolean {
  if (!rawBody || !signature) return false;
  const expected = crypto.createHmac("sha256", env.DROPBOX_APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── MIME por extensión (Dropbox no da mime; el Drive lo necesita) ────────────────
const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".ai": "application/postscript",
  ".eps": "application/postscript",
  ".psd": "image/vnd.adobe.photoshop",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFromName(name: string): string {
  return EXT_MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
}
