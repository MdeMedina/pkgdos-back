import fs from "node:fs";
import path from "node:path";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";

/**
 * Versionado de archivos del Drive.
 *
 * `drive_files` es la IDENTIDAD lógica del archivo (nombre visible, carpeta, marca,
 * `full_path`); cada subida física es una fila de `drive_file_versions`. La fila de
 * `drive_files` ESPEJEA siempre `url`/`mime_type`/`size` de la versión vigente, así que
 * todo lo que ya existía —árbol de la UI, links de descarga, herramientas del agente—
 * sigue leyendo la versión actual sin enterarse de que hay versiones.
 *
 * Avanzar/retroceder es NO DESTRUCTIVO: solo mueve `current_version_id`. Los chunks de
 * pgvector se guardan con `version_id`, y las búsquedas del agente filtran por
 * `version_id = drive_files.current_version_id`; por eso restaurar una versión devuelve
 * al agente el contenido de esa versión al instante, sin reingestar.
 */

export class VersionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface VersionRow {
  id: string;
  version: number;
  name: string;
  url: string;
  mime_type: string;
  size: number;
  note: string | null;
  uploaded_by: string | null;
  created_at: Date;
}

/** Borra el binario de una versión del disco (las versiones no comparten archivo). */
export function unlinkVersionFile(url: string | null | undefined) {
  if (!url) return;
  try {
    const filePath = path.join(env.UPLOADS_DIR, path.basename(url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`[Drive] Failed to unlink version file ${url}:`, err);
  }
}

/** Historial completo, de la más nueva a la más vieja, con el nombre de quien la subió. */
export async function listVersions(fileId: string) {
  const rows = await prisma.$queryRaw<
    Array<VersionRow & { uploader_name: string | null }>
  >`
    SELECT v.id, v.version, v.name, v.url, v.mime_type, v.size, v.note,
           v.uploaded_by, v.created_at, u.full_name AS uploader_name
    FROM drive_file_versions v
    LEFT JOIN users u ON u.id = v.uploaded_by
    WHERE v.file_id = ${fileId}::uuid
    ORDER BY v.version DESC
  `;
  return rows;
}

/**
 * Registra una subida como versión siguiente y la deja vigente.
 * Devuelve la versión creada. El nombre visible del archivo NO cambia: la identidad
 * pertenece a `drive_files` (si el operador quiere renombrarlo, es un PATCH aparte).
 */
export async function addVersion(
  fileId: string,
  upload: { originalname: string; filename: string; mimetype: string; size: number },
  meta: { note?: string | null; uploaded_by?: string | null },
) {
  const url = `/uploads/${upload.filename}`;

  return prisma.$transaction(async (tx) => {
    const file = await tx.driveFile.findUnique({ where: { id: fileId } });
    if (!file) throw new VersionError("File not found", 404);

    const last = await tx.driveFileVersion.findFirst({
      where: { file_id: fileId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextNumber = (last?.version ?? 0) + 1;

    const version = await tx.driveFileVersion.create({
      data: {
        file_id: fileId,
        version: nextNumber,
        name: upload.originalname,
        url,
        mime_type: upload.mimetype,
        size: upload.size,
        note: meta.note?.trim() || null,
        uploaded_by: meta.uploaded_by ?? null,
      },
    });

    const count = await tx.driveFileVersion.count({ where: { file_id: fileId } });
    await tx.driveFile.update({
      where: { id: fileId },
      data: {
        current_version_id: version.id,
        version_count: count,
        // Espejo de la versión vigente.
        url: version.url,
        mime_type: version.mime_type,
        size: version.size,
      },
    });

    return version;
  });
}

/**
 * Mueve el puntero de versión vigente (retroceder o avanzar). No borra nada: la versión
 * que estaba vigente sigue en el historial y se puede volver a ella.
 */
export async function setCurrentVersion(fileId: string, versionId: string) {
  return prisma.$transaction(async (tx) => {
    const version = await tx.driveFileVersion.findUnique({ where: { id: versionId } });
    if (!version || version.file_id !== fileId) {
      throw new VersionError("Version not found for this file", 404);
    }
    const file = await tx.driveFile.update({
      where: { id: fileId },
      data: {
        current_version_id: version.id,
        url: version.url,
        mime_type: version.mime_type,
        size: version.size,
      },
    });
    return { file, version };
  });
}

/**
 * Elimina una versión del historial (nunca la vigente) junto con su binario y sus chunks.
 * Los números de versión NO se renumeran: `v2` borrada deja el historial 1, 3, 4 — así los
 * chunks y las referencias existentes siguen apuntando a lo mismo.
 */
export async function deleteVersion(fileId: string, versionId: string) {
  const file = await prisma.driveFile.findUnique({ where: { id: fileId } });
  if (!file) throw new VersionError("File not found", 404);
  if (file.current_version_id === versionId) {
    throw new VersionError("Cannot delete the current version; restore another one first", 409);
  }
  const version = await prisma.driveFileVersion.findUnique({ where: { id: versionId } });
  if (!version || version.file_id !== fileId) {
    throw new VersionError("Version not found for this file", 404);
  }
  if ((await prisma.driveFileVersion.count({ where: { file_id: fileId } })) <= 1) {
    throw new VersionError("A file must keep at least one version", 409);
  }

  await prisma.driveFileVersion.delete({ where: { id: versionId } }); // cascada a sus chunks
  unlinkVersionFile(version.url);
  const count = await prisma.driveFileVersion.count({ where: { file_id: fileId } });
  await prisma.driveFile.update({ where: { id: fileId }, data: { version_count: count } });
  return { removed: version.version, version_count: count };
}
