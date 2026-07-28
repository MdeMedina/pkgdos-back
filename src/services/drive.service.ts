import { prisma } from "../config/database.js";

/**
 * Materialized Path helpers for the Drive.
 * Convention: folder.full_path always starts and ends with "/", e.g. "/Marketing/2026/".
 * A file's full_path = parent folder full_path + file name (no trailing slash), e.g.
 * "/Marketing/2026/brief.pdf". Root-level files (no folder) => "/brief.pdf".
 */

export const ROOT = "/";

/** Reject names that would corrupt the materialized path. */
export function assertValidName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw Object.assign(new Error("Name is required"), { status: 400 });
  if (trimmed.includes("/")) throw Object.assign(new Error('Name cannot contain "/"'), { status: 400 });
  return trimmed;
}

/** Compute the full_path a folder would have under a given parent. */
export async function computeFolderPath(parentId: string | null, name: string): Promise<string> {
  const clean = assertValidName(name);
  if (!parentId) return `/${clean}/`;
  const parent = await prisma.driveFolder.findUnique({ where: { id: parentId } });
  if (!parent) throw Object.assign(new Error("Parent folder not found"), { status: 404 });
  return `${parent.full_path}${clean}/`;
}

/** Compute the full_path a file would have inside a given folder (or root). */
export function computeFilePath(folderFullPath: string | null, name: string): string {
  const clean = assertValidName(name);
  if (!folderFullPath) return `/${clean}`;
  return `${folderFullPath}${clean}`;
}

/**
 * Re-point a folder (rename and/or move) and cascade the materialized path to every
 * descendant folder AND file in a single transaction. Prefix-replacement is done in raw
 * SQL so a subtree of any depth is updated in two statements.
 *
 * NOTE: already-vectorized chunks keep the stale full_path metadata; a move does not
 * re-embed. That is acceptable for now (the file id / url stay stable).
 */
export async function repathFolderSubtree(
  folderId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  if (oldPath === newPath) return;
  const oldLen = oldPath.length;

  // NOTE: the offset is cast to ::int — Prisma binds JS numbers as bigint and
  // substring(text FROM bigint) has no overload in Postgres (error 42883).
  await prisma.$transaction([
    // Folders: the folder itself (substring => "") plus every descendant.
    prisma.$executeRaw`
      UPDATE drive_folders
      SET full_path = ${newPath} || substring(full_path FROM ${oldLen + 1}::int),
          updated_at = now()
      WHERE full_path LIKE ${oldPath + "%"}
    `,
    // Files living anywhere under the moved subtree.
    prisma.$executeRaw`
      UPDATE drive_files
      SET full_path = ${newPath} || substring(full_path FROM ${oldLen + 1}::int)
      WHERE full_path LIKE ${oldPath + "%"}
    `,
  ]);
}
