import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import {
  DbxEntry,
  DropboxError,
  getTemporaryLink,
  listFolderAll,
  listFolderDelta,
  mimeFromName,
} from "./dropbox.service.js";

/**
 * Espejo en vivo Dropbox → Drive interno.
 *
 * Convenciones que respetamos del Drive existente:
 *  - Materialized path: folder.full_path empieza y termina en "/"; file.full_path =
 *    carpeta + nombre (sin "/" final).
 *  - Cada carpeta/archivo lleva un brand_id "relacionado". Aquí lo derivamos de la carpeta
 *    de marca de primer nivel bajo la raíz (p.ej. /EXTERNAL DOWNLOADS/PKGD/... => marca PKGD);
 *    si no coincide con ninguna marca, cae a PKGD.
 *
 * Estrategia "enlace directo": el binario NO se copia a /uploads. Para archivos DROPBOX,
 * `url` apunta a /api/drive/dropbox/raw/<id>, que hace 302 a un enlace temporal fresco.
 * El contenido se descarga solo de forma efímera para vectorizar (vía n8n) y para el preview.
 */

const SINGLETON = "singleton";
const ROOT = env.DROPBOX_ROOT_PATH; // "/EXTERNAL DOWNLOADS"
const ROOT_LOWER = ROOT.toLowerCase();

// Documentos con texto → rama Tika del flujo de ingesta n8n.
const DOC_EXT = new Set([
  ".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".csv",
  ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".epub",
]);
// Imágenes que el flujo describe con visión (gpt-5-mini). Solo estos formatos: el IF
// "Es imagen?" del flujo enruta ^image/(png|jpe?g|gif|webp)$ a visión; otros (svg/tiff/bmp)
// caerían a Tika y fallarían. Video, audio y binarios de diseño (.ai/.psd) NO se indexan
// (se espejan y quedan descargables, pero no son buscables por concepto).
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
function isIndexable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return DOC_EXT.has(ext) || IMG_EXT.has(ext);
}

// Candado en memoria: los webhooks de Dropbox pueden solaparse; una corrida a la vez.
let syncing = false;
let rerunRequested = false;

// ── Marca por carpeta de primer nivel ───────────────────────────────────────────
let pkgdBrandIdCache: string | null = null;
async function pkgdBrandId(): Promise<string | null> {
  if (pkgdBrandIdCache) return pkgdBrandIdCache;
  const brand = await prisma.brand.findFirst({ where: { name: "PKGD" }, select: { id: true } });
  pkgdBrandIdCache = brand?.id ?? null;
  return pkgdBrandIdCache;
}

/** Primer segmento bajo la raíz: "/EXTERNAL DOWNLOADS/PKGD/x/y.png" => "PKGD". */
function topSegment(pathDisplay: string): string | null {
  const rel = pathDisplay.slice(ROOT.length).replace(/^\/+/, ""); // "PKGD/x/y.png"
  const seg = rel.split("/")[0];
  return seg || null;
}

const brandByNameCache = new Map<string, string | null>();
async function brandIdForPath(pathDisplay: string): Promise<string | null> {
  const seg = topSegment(pathDisplay);
  if (!seg) return pkgdBrandId();
  const key = seg.toLowerCase();
  if (brandByNameCache.has(key)) return brandByNameCache.get(key)!;
  const brand = await prisma.brand.findFirst({
    where: { name: { equals: seg, mode: "insensitive" } },
    select: { id: true },
  });
  const id = brand?.id ?? (await pkgdBrandId());
  brandByNameCache.set(key, id);
  return id;
}

// ── Raíz del espejo ──────────────────────────────────────────────────────────────
/** Carpeta Drive que representa la raíz espejada ("/EXTERNAL DOWNLOADS/"). */
async function ensureRootFolder() {
  const existing = await prisma.driveFolder.findFirst({ where: { dropbox_path_lower: ROOT_LOWER } });
  if (existing) return existing;
  const name = ROOT.replace(/^\/+/, "").split("/").pop() || "Dropbox";
  return prisma.driveFolder.create({
    data: {
      name,
      parent_id: null,
      full_path: `${ROOT}/`,
      brand_id: await pkgdBrandId(),
      source: "DROPBOX",
      dropbox_path_lower: ROOT_LOWER,
    },
  });
}

/**
 * Asegura la cadena de carpetas Drive para un path_display de Dropbox y devuelve la
 * carpeta hoja. Crea ancestros faltantes (por si el delta trae un hijo antes que el padre).
 */
async function ensureFolderChain(pathDisplay: string) {
  const rootFolder = await ensureRootFolder();
  const rel = pathDisplay.slice(ROOT.length).replace(/^\/+/, ""); // "PKGD/Social/Agosto"
  if (!rel) return rootFolder;

  const segments = rel.split("/");
  let parent = rootFolder;
  let accPath = pathDisplay.slice(0, ROOT.length); // "/EXTERNAL DOWNLOADS"
  for (const seg of segments) {
    accPath += `/${seg}`;
    const lower = accPath.toLowerCase();
    let node = await prisma.driveFolder.findFirst({ where: { dropbox_path_lower: lower } });
    if (!node) {
      node = await prisma.driveFolder.create({
        data: {
          name: seg,
          parent_id: parent.id,
          full_path: `${parent.full_path}${seg}/`,
          brand_id: await brandIdForPath(accPath),
          source: "DROPBOX",
          dropbox_path_lower: lower,
        },
      });
    }
    parent = node;
  }
  return parent;
}

// ── Aplicar entradas ──────────────────────────────────────────────────────────────
async function applyFolder(entry: Extract<DbxEntry, { ".tag": "folder" }>) {
  const folder = await ensureFolderChain(entry.path_display);
  // Enlaza el id de Dropbox si faltaba (ensureFolderChain crea por path).
  if (folder.dropbox_id !== entry.id) {
    await prisma.driveFolder
      .update({ where: { id: folder.id }, data: { dropbox_id: entry.id } })
      .catch(() => {}); // id único: si choca por una carrera, se ignora
  }
}

async function applyFile(entry: Extract<DbxEntry, { ".tag": "file" }>) {
  const parentDisplay = entry.path_display.slice(0, entry.path_display.length - entry.name.length - 1);
  const folder = await ensureFolderChain(parentDisplay);
  const brand_id = await brandIdForPath(entry.path_display);
  const full_path = `${folder.full_path}${entry.name}`;
  const mime = mimeFromName(entry.name);
  const lower = entry.path_lower;

  const existing = await prisma.driveFile.findFirst({ where: { dropbox_id: entry.id } });
  const contentChanged = !existing || existing.dropbox_rev !== entry.rev;

  let fileId: string;
  if (!existing) {
    const created = await prisma.driveFile.create({
      data: {
        name: entry.name,
        url: "", // se completa abajo con el id
        mime_type: mime,
        size: entry.size,
        folder_id: folder.id,
        brand_id,
        full_path,
        source: "DROPBOX",
        dropbox_id: entry.id,
        dropbox_path_lower: lower,
        dropbox_rev: entry.rev,
        dropbox_content_hash: entry.content_hash ?? null,
        version_count: 1,
      },
    });
    fileId = created.id;
    // Versión única (estable): da un version_id a los chunks sin exponer historial interno.
    const version = await prisma.driveFileVersion.create({
      data: {
        file_id: fileId,
        version: 1,
        name: entry.name,
        url: `/api/drive/dropbox/raw/${fileId}`,
        mime_type: mime,
        size: entry.size,
        note: "Dropbox (espejo)",
      },
    });
    await prisma.driveFile.update({
      where: { id: fileId },
      data: { url: `/api/drive/dropbox/raw/${fileId}`, current_version_id: version.id },
    });
  } else {
    fileId = existing.id;
    await prisma.driveFile.update({
      where: { id: fileId },
      data: {
        name: entry.name,
        mime_type: mime,
        size: entry.size,
        folder_id: folder.id,
        brand_id,
        full_path,
        dropbox_path_lower: lower,
        dropbox_rev: entry.rev,
        dropbox_content_hash: entry.content_hash ?? null,
      },
    });
    if (existing.current_version_id) {
      await prisma.driveFileVersion
        .update({
          where: { id: existing.current_version_id },
          data: { name: entry.name, mime_type: mime, size: entry.size },
        })
        .catch(() => {});
    }
  }

  // Vectorización: solo si el contenido cambió Y es un formato con texto. Se descarta lo
  // viejo y n8n reingesta desde un enlace temporal directo (nada toca /uploads).
  if (contentChanged && isIndexable(entry.name)) {
    await prisma.fileVectorChunk.deleteMany({ where: { file_id: fileId } });
    await notifyIngest(fileId, entry, full_path, mime, brand_id).catch((e) =>
      console.error(`[DropboxSync] ingest dispatch failed for ${entry.path_display}:`, e?.message ?? e)
    );
  }
}

async function applyDeleted(entry: Extract<DbxEntry, { ".tag": "deleted" }>) {
  const lower = entry.path_lower;
  // ¿Era un archivo? bórralo (cascada versiones + chunks).
  const file = await prisma.driveFile.findFirst({ where: { dropbox_path_lower: lower } });
  if (file) {
    await prisma.driveFile.delete({ where: { id: file.id } }).catch(() => {});
    return;
  }
  // ¿Una carpeta? bórrala (cascada FK borra subárbol y archivos DROPBOX de dentro).
  const folder = await prisma.driveFolder.findFirst({ where: { dropbox_path_lower: lower } });
  if (folder && folder.dropbox_path_lower !== ROOT_LOWER) {
    await prisma.driveFolder.delete({ where: { id: folder.id } }).catch(() => {});
  }
}

/**
 * Reutiliza el pipeline de ingesta existente (n8n → Tika → embed → file_vector_chunks).
 * A diferencia de un upload local, la `url` es un enlace temporal DIRECTO de Dropbox: n8n
 * descarga desde ahí, nada toca nuestros /uploads.
 */
async function notifyIngest(
  fileId: string,
  entry: Extract<DbxEntry, { ".tag": "file" }>,
  fullPath: string,
  mime: string,
  brandId: string | null
) {
  if (!env.N8N_BASE_URL) return;
  const versionId = (await prisma.driveFile.findUnique({ where: { id: fileId } }))?.current_version_id;
  const base = env.APP_BASE_URL;
  // Imágenes: se describen desde una MINIATURA de Dropbox (~1MB) para no reventar el tope de
  // tamaño del pipeline de visión con originales de decenas de MB. Documentos: enlace temporal
  // directo (Tika necesita el binario completo para extraer el texto).
  const isImg = IMG_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase());
  const ingestUrl = isImg
    ? `${base}/api/drive/dropbox/thumb/${fileId}`
    : await getTemporaryLink(entry.id);
  const res = await fetch(`${env.N8N_BASE_URL}/webhook/drive-file-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
    body: JSON.stringify({
      file_id: fileId,
      version_id: versionId,
      version: 1,
      url: ingestUrl,
      full_path: fullPath,
      mime_type: mime,
      name: entry.name,
      brand_id: brandId,
      callback_url: `${base}/api/drive/callback`,
      source: "dropbox",
    }),
  });
  if (!res.ok) {
    console.error(`[DropboxSync] ingest webhook ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

// ── Orquestación ─────────────────────────────────────────────────────────────────
async function reconcile(entries: DbxEntry[]) {
  for (const entry of entries) {
    // Ignora cualquier cosa fuera de la carpeta espejada (defensa en profundidad).
    const p = "path_lower" in entry ? entry.path_lower : "";
    if (p && p !== ROOT_LOWER && !p.startsWith(ROOT_LOWER + "/")) continue;
    try {
      if (entry[".tag"] === "folder") await applyFolder(entry);
      else if (entry[".tag"] === "file") await applyFile(entry);
      else if (entry[".tag"] === "deleted") await applyDeleted(entry);
    } catch (e: any) {
      console.error(`[DropboxSync] entry failed (${entry[".tag"]} ${p}):`, e?.message ?? e);
    }
  }
}

async function loadState() {
  return prisma.dropboxSyncState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, root_path: ROOT },
    update: {},
  });
}

/**
 * Corre una pasada de sincronización. Sin cursor => importación inicial completa; con
 * cursor => solo el delta. Serializa corridas y encola una re-corrida si llega un webhook
 * mientras trabaja (coalescing), para no perder cambios.
 */
export async function syncDropbox(): Promise<{ ok: boolean; mode: string; count?: number; error?: string }> {
  if (syncing) {
    rerunRequested = true;
    return { ok: true, mode: "queued" };
  }
  syncing = true;
  try {
    const state = await loadState();
    let result: { entries: DbxEntry[]; cursor: string };
    let mode: string;
    if (!state.cursor) {
      mode = "initial";
      result = await listFolderAll(ROOT);
    } else {
      mode = "delta";
      result = await listFolderDelta(state.cursor);
    }
    await reconcile(result.entries);
    await prisma.dropboxSyncState.update({
      where: { id: SINGLETON },
      data: { cursor: result.cursor, last_synced_at: new Date(), last_error: null },
    });
    console.log(`[DropboxSync] ${mode}: ${result.entries.length} entradas procesadas.`);
    return { ok: true, mode, count: result.entries.length };
  } catch (e: any) {
    const msg = e instanceof DropboxError ? e.message : e?.message ?? "error desconocido";
    console.error("[DropboxSync] falló:", msg);
    await prisma.dropboxSyncState
      .update({ where: { id: SINGLETON }, data: { last_error: msg } })
      .catch(() => {});
    // Si el cursor se invalidó (reset), la próxima corrida re-importa desde cero.
    if (/reset|cursor/i.test(msg)) {
      await prisma.dropboxSyncState
        .update({ where: { id: SINGLETON }, data: { cursor: null } })
        .catch(() => {});
    }
    return { ok: false, mode: "error", error: msg };
  } finally {
    syncing = false;
    if (rerunRequested) {
      rerunRequested = false;
      // Encola sin bloquear al llamador (p.ej. la respuesta 200 del webhook ya salió).
      setImmediate(() => void syncDropbox());
    }
  }
}
