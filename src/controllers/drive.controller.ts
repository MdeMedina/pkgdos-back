import { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import {
  AuthenticatedRequest,
  DepartmentContext,
  resolveDepartmentContext,
} from "../middlewares/auth.middleware.js";
import {
  assertValidName,
  computeFolderPath,
  computeFilePath,
  repathFolderSubtree,
} from "../services/drive.service.js";
import { ensureFolderByPath } from "../services/drive-asset.service.js";
import {
  isConvertible,
  renderPreviewHtml,
  renderPreviewHtmlFromBuffer,
  PreviewError,
} from "../services/drive-preview.service.js";
import { download as dropboxDownload, DropboxError } from "../services/dropbox.service.js";
import {
  addVersion,
  deleteVersion,
  listVersions,
  setCurrentVersion,
  unlinkVersionFile,
  VersionError,
} from "../services/drive-version.service.js";

/** Absolute base URL (respects reverse proxy) so n8n/Tika can fetch the file. */
function absoluteBase(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Resolve the default "related brand" for the Drive: PKGD. A folder/file created
 * without an explicit brand relates to PKGD. Cached after first lookup.
 */
let pkgdBrandIdCache: string | null = null;
async function pkgdBrandId(): Promise<string | null> {
  if (pkgdBrandIdCache) return pkgdBrandIdCache;
  const brand = await prisma.brand.findFirst({ where: { name: "PKGD" }, select: { id: true } });
  pkgdBrandIdCache = brand?.id ?? null;
  return pkgdBrandIdCache;
}

/** Physically remove a file from the uploads dir given its stored relative url. */
function unlinkPhysical(url: string | null | undefined) {
  if (!url) return;
  try {
    const filePath = path.join(env.UPLOADS_DIR, path.basename(url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error(`[Drive] Failed to unlink physical file for ${url}:`, err);
  }
}

/** Mensaje único para operaciones bloqueadas sobre nodos espejo de Dropbox. */
const DROPBOX_READONLY = {
  message:
    "Este elemento es un espejo de solo lectura de Dropbox. Gestiónalo (renombrar, mover, versionar o eliminar) directamente en Dropbox; el cambio se reflejará aquí automáticamente.",
};

export class DriveController {
  // ── Department visibility (folder anchoring) ────────────
  // A folder anchored to N departments (rows in drive_folder_departments) is visible
  // only to users of those departments (or admins). A folder with NO rows is visible to
  // everyone (backward compat). The restriction CASCADES to the subtree: if an ancestor is
  // hidden, its whole subtree is hidden. Files inherit their folder's visibility.
  //
  // Implemented with raw SQL (like rebrandSubtree) so it is robust against the known
  // schema.prisma <-> prod DB drift: it never depends on a regenerated Prisma client.

  /** Load the folder→departments anchoring once. Returns the per-folder set (for UI badges/
   *  prefill) and the list of RESTRICTED folder paths + their allowed departments (for the
   *  cascade filter). Joined against drive_folders so full_path is authoritative. */
  private static async loadFolderDepartments(): Promise<{
    deptByFolder: Map<string, string[]>;
    restricted: Array<{ full_path: string; depts: Set<string> }>;
  }> {
    const rows = await prisma.$queryRaw<
      Array<{ folder_id: string; full_path: string; department_id: string }>
    >`
      SELECT dfd.folder_id, f.full_path, dfd.department_id
      FROM drive_folder_departments dfd
      JOIN drive_folders f ON f.id = dfd.folder_id
    `;
    const deptByFolder = new Map<string, string[]>();
    const pathDepts = new Map<string, Set<string>>();
    for (const r of rows) {
      const arr = deptByFolder.get(r.folder_id);
      if (arr) arr.push(r.department_id);
      else deptByFolder.set(r.folder_id, [r.department_id]);

      const s = pathDepts.get(r.full_path);
      if (s) s.add(r.department_id);
      else pathDepts.set(r.full_path, new Set([r.department_id]));
    }
    const restricted = Array.from(pathDepts, ([full_path, depts]) => ({ full_path, depts }));
    return { deptByFolder, restricted };
  }

  /** full_paths of folders the caller may NOT see. A folder is denied when it is restricted
   *  and the caller's department is not in its allow-set (or the caller has no department).
   *  Admins and an unresolved context (agent w/o user_id) see everything → []. */
  private static deniedPrefixes(
    restricted: Array<{ full_path: string; depts: Set<string> }>,
    ctx: DepartmentContext | null,
  ): string[] {
    if (!ctx || ctx.isAdmin) return [];
    // Ve la carpeta si CUALQUIERA de sus departamentos esta en la lista permitida.
    return restricted
      .filter((r) => !ctx.departmentIds.some((id) => r.depts.has(id)))
      .map((r) => r.full_path);
  }

  /** True when `fullPath` lives under any denied folder (itself included). Since folder
   *  full_paths always end with "/", startsWith is a safe subtree test. */
  private static isHiddenPath(fullPath: string, denied: string[]): boolean {
    return denied.some((dp) => fullPath.startsWith(dp));
  }

  // ── Folders ─────────────────────────────────────────────

  // POST /drive/folders  { name, parent_id?, brand_id? }
  // brand_id is the OPTIONAL "related brand" tag. When omitted it CASCADES: inherit the
  // parent folder's brand; at the root it relates to PKGD.
  static async createFolder(req: AuthenticatedRequest, res: Response) {
    try {
      const { name, parent_id = null } = req.body;
      let brand_id: string | null = req.body.brand_id || null;
      if (!brand_id) {
        if (parent_id) {
          const parent = await prisma.driveFolder.findUnique({
            where: { id: parent_id },
            select: { brand_id: true },
          });
          brand_id = parent?.brand_id ?? null;
        }
        if (!brand_id) brand_id = await pkgdBrandId();
      }
      const full_path = await computeFolderPath(parent_id, name);

      const folder = await prisma.driveFolder.create({
        data: { name: assertValidName(name), parent_id, brand_id, full_path },
      });
      return res.status(201).json(folder);
    } catch (error: any) {
      console.error("Create folder error:", error);
      return res.status(error.status || 500).json({ message: error.message || "Failed to create folder" });
    }
  }

  // PATCH /drive/folders/:id  { name?, parent_id?, brand_id? }  — rename, move and/or re-brand
  static async updateFolder(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, parent_id } = req.body as { name?: string; parent_id?: string | null };
      const brandProvided = Object.prototype.hasOwnProperty.call(req.body, "brand_id");
      const nextBrandId: string | null = req.body.brand_id || null;

      const folder = await prisma.driveFolder.findUnique({ where: { id } });
      if (!folder) return res.status(404).json({ message: "Folder not found" });
      if (folder.source === "DROPBOX") return res.status(409).json(DROPBOX_READONLY);

      const nextName = name !== undefined ? assertValidName(name) : folder.name;
      const nextParentId = parent_id !== undefined ? parent_id : folder.parent_id;
      const moved = nextParentId !== folder.parent_id;
      let parentBrandId: string | null = null;

      // Guard against cycles: cannot move a folder into itself or one of its descendants.
      if (nextParentId) {
        if (nextParentId === id) {
          return res.status(400).json({ message: "A folder cannot be its own parent" });
        }
        const target = await prisma.driveFolder.findUnique({ where: { id: nextParentId } });
        if (!target) return res.status(404).json({ message: "Target parent folder not found" });
        if (target.full_path.startsWith(folder.full_path)) {
          return res.status(400).json({ message: "Cannot move a folder into its own subtree" });
        }
        parentBrandId = target.brand_id;
      }

      // MOVING RE-BRANDS: dropped into another folder, the subtree adopts that folder's related
      // brand (PKGD at root) unless brand_id was sent explicitly.
      const targetBrandId: string | null =
        brandProvided || !moved ? nextBrandId : parentBrandId ?? (await pkgdBrandId());

      const newPath = await computeFolderPath(nextParentId, nextName);

      await prisma.driveFolder.update({
        where: { id },
        data: { name: nextName, parent_id: nextParentId },
      });
      // Cascade the materialized path to the whole subtree (folders + files).
      await repathFolderSubtree(id, folder.full_path, newPath);

      // Re-brand cascade: if the related brand changed, propagate the new brand to this folder
      // and to every descendant that was INHERITING the old brand — descendants with a distinct
      // explicit brand (and their own subtrees) keep theirs.
      if ((brandProvided || moved) && targetBrandId !== folder.brand_id) {
        await DriveController.rebrandSubtree(newPath, folder.brand_id, targetBrandId);
      }

      const updated = await prisma.driveFolder.findUnique({ where: { id } });
      return res.status(200).json(updated);
    } catch (error: any) {
      console.error("Update folder error:", error);
      return res.status(error.status || 500).json({ message: error.message || "Failed to update folder" });
    }
  }

  // POST /drive/agent/manage — write operations exposed to the n8n agent (requireN8N).
  // Additive/relocate only (NO delete). Works by materialized PATH, not ids, since the
  // agent reasons over the tree it sees.
  //   { op: "create_folder", full_path: "/Marketing/G4/Social Media/Agosto/Test/" }
  //   { op: "move_file", (file_id | file_full_path), target_full_path: "/.../" }
  static async agentManage(req: Request, res: Response) {
    try {
      const { op } = req.body as { op?: string };

      if (op === "create_folder") {
        const { full_path } = req.body as { full_path?: string };
        if (!full_path) return res.status(400).json({ message: "full_path is required" });
        const folder = await ensureFolderByPath(full_path);
        return res.status(200).json({ ok: true, op, id: folder.id, full_path: folder.full_path });
      }

      if (op === "move_file") {
        const { file_id, file_full_path, target_full_path } = req.body as {
          file_id?: string;
          file_full_path?: string;
          target_full_path?: string;
        };
        if (!target_full_path) return res.status(400).json({ message: "target_full_path is required" });
        const file = file_id
          ? await prisma.driveFile.findUnique({ where: { id: file_id } })
          : file_full_path
            ? await prisma.driveFile.findFirst({ where: { full_path: file_full_path } })
            : null;
        if (!file) return res.status(404).json({ message: "File not found (give file_id or file_full_path)" });

        const folder = await ensureFolderByPath(target_full_path);
        const newFull = `${folder.full_path}${file.name}`;
        // Same rule as the UI drag & drop: a moved file adopts the destination folder's brand.
        const brand_id = folder.brand_id ?? (await pkgdBrandId());
        await prisma.driveFile.update({
          where: { id: file.id },
          data: { folder_id: folder.id, brand_id, full_path: newFull },
        });
        return res.status(200).json({ ok: true, op, moved: file.name, to: newFull, brand_id });
      }

      return res.status(400).json({ message: `Unknown op '${op ?? ""}' (create_folder | move_file)` });
    } catch (error: any) {
      console.error("Agent manage error:", error);
      return res.status(error.status || 500).json({ message: error.message || "Failed to manage drive" });
    }
  }

  // DELETE /drive/folders/:id — cascade-deletes subtree (DB FK) + unlinks physical files
  static async deleteFolder(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const folder = await prisma.driveFolder.findUnique({ where: { id } });
      if (!folder) return res.status(404).json({ message: "Folder not found" });
      if (folder.source === "DROPBOX") return res.status(409).json(DROPBOX_READONLY);

      // Collect every physical file under the subtree — including every version's binary —
      // before the cascade wipes the rows.
      const files = await prisma.driveFile.findMany({
        where: { full_path: { startsWith: folder.full_path } },
        select: { id: true, url: true },
      });
      const versions = await prisma.driveFileVersion.findMany({
        where: { file_id: { in: files.map((f) => f.id) } },
        select: { url: true },
      });

      await prisma.driveFolder.delete({ where: { id } }); // FK ON DELETE CASCADE
      files.forEach((f) => unlinkPhysical(f.url));
      versions.forEach((v) => unlinkVersionFile(v.url));

      return res.status(200).json({ message: "Folder and its contents deleted", removed_files: files.length });
    } catch (error: any) {
      console.error("Delete folder error:", error);
      return res.status(500).json({ message: "Failed to delete folder" });
    }
  }

  // GET /drive/folders/:brand_id/contents?parent_id=<id|null>
  // One level of the tree, for splat navigation in the UI.
  static async listContents(req: AuthenticatedRequest, res: Response) {
    try {
      const { brand_id } = req.params;
      const parentId = (req.query.parent_id as string) || null;

      // Department visibility gate (see loadFolderDepartments / deniedPrefixes).
      const deptCtx = await resolveDepartmentContext(req);
      const { deptByFolder, restricted } = await DriveController.loadFolderDepartments();
      const denied = DriveController.deniedPrefixes(restricted, deptCtx);

      // Navigating INTO a folder: the parent (and thus its ancestors) must be visible.
      if (parentId && denied.length) {
        const parent = await prisma.driveFolder.findUnique({
          where: { id: parentId },
          select: { full_path: true },
        });
        if (parent && DriveController.isHiddenPath(parent.full_path, denied)) {
          return res.status(403).json({ message: "No tienes acceso a esta carpeta" });
        }
      }

      const [folders, files] = await Promise.all([
        prisma.driveFolder.findMany({
          where: { brand_id, parent_id: parentId },
          orderBy: { name: "asc" },
        }),
        prisma.driveFile.findMany({
          where: { brand_id, folder_id: parentId },
          orderBy: { name: "asc" },
        }),
      ]);

      // Hide sibling folders the user may not see, and expose each folder's anchoring so the
      // admin UI can prefill its multiselect. Files inherit the (already-verified) parent's
      // visibility, so they pass through untouched.
      const visibleFolders = denied.length
        ? folders.filter((f) => !DriveController.isHiddenPath(f.full_path, denied))
        : folders;
      const foldersOut = visibleFolders.map((f) => ({
        ...f,
        department_ids: deptByFolder.get(f.id) ?? [],
      }));

      return res.status(200).json({ folders: foldersOut, files });
    } catch (error) {
      console.error("List contents error:", error);
      return res.status(500).json({ message: "Failed to list folder contents" });
    }
  }

  // PUT /drive/folders/:id/departments  { department_ids: string[] }  (requireAuth + admin)
  // REEMPLAZA el conjunto de departamentos a los que está anclada la carpeta (visibilidad).
  //   []            → sin anclaje: visible para TODOS (compat hacia atrás).
  //   [d1, d2, ...] → visible solo para usuarios de esos departamentos (o admin), y la
  //                   restricción cascadea al subárbol.
  // Se implementa con SQL crudo (robusto ante el drift schema.prisma <-> BD de prod).
  static async setFolderDepartments(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const body = req.body as { department_ids?: unknown };
      const ids = Array.isArray(body.department_ids) ? body.department_ids : null;
      if (!ids || !ids.every((x) => typeof x === "string")) {
        return res.status(400).json({ message: "department_ids debe ser un arreglo de UUIDs" });
      }
      const unique = Array.from(new Set(ids as string[]));

      const folder = await prisma.driveFolder.findUnique({ where: { id }, select: { id: true } });
      if (!folder) return res.status(404).json({ message: "Folder not found" });

      // Reject unknown department ids up front (a bad FK would otherwise blow up as a 500).
      if (unique.length) {
        const found = await prisma.department.findMany({
          where: { id: { in: unique } },
          select: { id: true },
        });
        if (found.length !== unique.length) {
          return res.status(400).json({ message: "Uno o más departamentos no existen" });
        }
      }

      // Replace the full set atomically: wipe then re-insert.
      await prisma.$transaction([
        prisma.$executeRaw`DELETE FROM drive_folder_departments WHERE folder_id = ${id}::uuid`,
        ...unique.map(
          (depId) => prisma.$executeRaw`
            INSERT INTO drive_folder_departments (folder_id, department_id)
            VALUES (${id}::uuid, ${depId}::uuid)
            ON CONFLICT DO NOTHING
          `,
        ),
      ]);

      return res.status(200).json({ folder_id: id, department_ids: unique });
    } catch (error: any) {
      console.error("Set folder departments error:", error);
      return res
        .status(error.status || 500)
        .json({ message: error.message || "Failed to set folder departments" });
    }
  }

  // ── Files ───────────────────────────────────────────────

  // POST /drive/upload  (multipart: file + { folder_id?, brand_id? })
  // The file's related brand is inherited from its folder; falls back to PKGD.
  static async upload(req: AuthenticatedRequest, res: Response) {
    const file = req.file;
    try {
      const { folder_id = null } = req.body;
      if (!file) return res.status(400).json({ message: "No file was uploaded" });

      // Resolve the parent folder (for materialized path + inherited brand).
      let folderPath: string | null = null;
      let folderBrandId: string | null = null;
      if (folder_id) {
        const folder = await prisma.driveFolder.findUnique({ where: { id: folder_id } });
        if (!folder) {
          fs.unlinkSync(file.path);
          return res.status(404).json({ message: "Target folder not found" });
        }
        folderPath = folder.full_path;
        folderBrandId = folder.brand_id;
      }

      // Explicit body brand_id > folder's brand > PKGD default.
      const brand_id = req.body.brand_id || folderBrandId || (await pkgdBrandId());
      const url = `/uploads/${file.filename}`;
      const full_path = computeFilePath(folderPath, file.originalname);
      // Jerarquía ante el agente: RECTOR (siempre en contexto de su marca) o NORMAL (default).
      const doc_tier =
        req.body.doc_tier === "GLOBAL" ? "GLOBAL" : req.body.doc_tier === "RECTOR" ? "RECTOR" : "NORMAL";

      const created = await prisma.driveFile.create({
        data: {
          name: file.originalname,
          url,
          mime_type: file.mimetype,
          size: file.size,
          folder_id,
          brand_id,
          full_path,
          doc_tier,
        },
      });

      // Every upload is a version; the first one is v1 and becomes the current one.
      const version = await prisma.driveFileVersion.create({
        data: {
          file_id: created.id,
          version: 1,
          name: file.originalname,
          url,
          mime_type: file.mimetype,
          size: file.size,
          uploaded_by: req.user?.id ?? null,
        },
      });
      const withVersion = await prisma.driveFile.update({
        where: { id: created.id },
        data: { current_version_id: version.id, version_count: 1 },
      });

      // Un .zip NO se vectoriza como blob: queda como contenedor y su contenido se extrae
      // a una subcarpeta (con su nombre) donde cada documento se ingesta por separado.
      if (DriveController.isZipFile(file.originalname, file.mimetype)) {
        const subfolderFullPath = DriveController.zipSubfolderPath(folderPath, file.originalname);
        try {
          const { count, folderId } = await DriveController.expandZipInto(req, file.path, {
            subfolderFullPath,
            brandId: brand_id,
            docTier: doc_tier as "GLOBAL" | "RECTOR" | "NORMAL",
          });
          const linked = await prisma.driveFile.update({
            where: { id: withVersion.id },
            data: { zip_expanded_folder_id: folderId },
          });
          return res.status(201).json({ ...linked, expanded_files: count });
        } catch (zErr) {
          console.error("[Drive] zip expand failed:", zErr);
          return res.status(201).json({ ...withVersion, expanded_files: 0, zip_error: true });
        }
      }

      // Fire-and-forget async ingest notification to n8n (never blocks the upload response).
      DriveController.notifyIngest(req, withVersion, version).catch((e) =>
        console.error("[Drive] ingest webhook dispatch failed:", e)
      );

      return res.status(201).json(withVersion);
    } catch (error) {
      console.error("Upload file error:", error);
      if (file) unlinkPhysical(`/uploads/${file.filename}`);
      return res.status(500).json({ message: "Failed to upload file" });
    }
  }

  // POST /drive/google-sync  (requireN8N, multipart: file=<doc exportado>)  — sincronización
  // programada Google Drive → RAG. n8n exporta el Google Doc (vía la Service Account) y lo
  // sube aquí; nosotros lo hacemos un archivo REAL del Drive de PKGD y disparamos la MISMA
  // ingesta (Tika→trocea→embeddings→file_vector_chunks) que cualquier subida.
  //   - Vínculo estable por `gdoc_id`: si ya existe, se sube una VERSIÓN nueva (conserva historial
  //     y re-vectoriza); si no, se crea el archivo.
  //   - `doc_tier` por defecto RECTOR (siempre en contexto del agente para su marca).
  // Campos (form-data): gdoc_id (req), name, brand_id, folder_id, doc_tier, gdoc_modified_time.
  static async googleSync(req: Request, res: Response) {
    const upload = (req as AuthenticatedRequest).file;
    try {
      if (!upload) return res.status(400).json({ message: "No file was uploaded" });
      const b = (req.body ?? {}) as Record<string, string>;
      const gdoc_id = String(b.gdoc_id || "").trim();
      if (!gdoc_id) {
        unlinkPhysical(`/uploads/${upload.filename}`);
        return res.status(400).json({ message: "gdoc_id is required" });
      }
      const name = String(b.name || upload.originalname);
      const gdoc_modified_time = b.gdoc_modified_time ? String(b.gdoc_modified_time) : null;
      const doc_tier =
        b.doc_tier === "GLOBAL" ? "GLOBAL" : b.doc_tier === "NORMAL" ? "NORMAL" : "RECTOR";

      // Carpeta destino (opcional) → hereda marca; explicit brand_id gana; fallback PKGD.
      const folder_id = b.folder_id || null;
      let folderPath: string | null = null;
      let folderBrandId: string | null = null;
      if (folder_id) {
        const folder = await prisma.driveFolder.findUnique({ where: { id: folder_id } });
        if (folder) {
          folderPath = folder.full_path;
          folderBrandId = folder.brand_id;
        }
      }
      const brand_id = b.brand_id || folderBrandId || (await pkgdBrandId());

      const existing = await prisma.driveFile.findFirst({ where: { gdoc_id } });

      if (existing) {
        // ¿Cambió realmente? Si el modifiedTime coincide, no re-ingestamos (evita trabajo/costo).
        if (gdoc_modified_time && existing.gdoc_modified_time === gdoc_modified_time) {
          unlinkPhysical(`/uploads/${upload.filename}`);
          return res.status(200).json({ file: existing, action: "unchanged" });
        }
        await prisma.driveFile.update({
          where: { id: existing.id },
          data: { name, doc_tier, brand_id, gdoc_modified_time },
        });
        const version = await addVersion(existing.id, upload, {
          note: "google-sync",
          uploaded_by: null,
        });
        const file = (await prisma.driveFile.findUnique({ where: { id: existing.id } }))!;
        DriveController.forgetPreview(version.id);
        DriveController.notifyIngest(req, file, version).catch((e) =>
          console.error("[Drive] ingest webhook dispatch failed:", e),
        );
        return res.status(200).json({ file, version, action: "updated" });
      }

      // Alta nueva: archivo + versión 1 + ingesta.
      const url = `/uploads/${upload.filename}`;
      const full_path = computeFilePath(folderPath, name);
      const created = await prisma.driveFile.create({
        data: {
          name,
          url,
          mime_type: upload.mimetype,
          size: upload.size,
          folder_id,
          brand_id,
          full_path,
          doc_tier,
          gdoc_id,
          gdoc_modified_time,
        },
      });
      const version = await prisma.driveFileVersion.create({
        data: {
          file_id: created.id,
          version: 1,
          name,
          url,
          mime_type: upload.mimetype,
          size: upload.size,
          uploaded_by: null,
        },
      });
      const withVersion = await prisma.driveFile.update({
        where: { id: created.id },
        data: { current_version_id: version.id, version_count: 1 },
      });
      DriveController.notifyIngest(req, withVersion, version).catch((e) =>
        console.error("[Drive] ingest webhook dispatch failed:", e),
      );
      return res.status(201).json({ file: withVersion, version, action: "created" });
    } catch (error) {
      console.error("Google sync error:", error);
      if (upload) unlinkPhysical(`/uploads/${upload.filename}`);
      return res.status(500).json({ message: "Failed to sync google doc" });
    }
  }

  // ── ZIP: expandir el contenido a archivos reales del Drive ───────────────────
  // Un .zip no se vectoriza como blob: se guarda como contenedor (sin ingesta) y su
  // contenido se extrae a una SUBCARPETA con el nombre del zip; cada documento es un
  // archivo del Drive independiente (misma marca/tier) que se ingesta uno a uno.
  static isZipFile(name: string, mime: string): boolean {
    const m = (mime || "").toLowerCase();
    return (
      m === "application/zip" ||
      m === "application/x-zip-compressed" ||
      m === "application/x-zip" ||
      (name || "").toLowerCase().endsWith(".zip")
    );
  }

  // Ruta de la subcarpeta dedicada al contenido del zip (hermana del zip, con su nombre).
  private static zipSubfolderPath(parentFolderPath: string | null, zipName: string): string {
    const base = zipName.replace(/\.zip$/i, "").trim() || zipName;
    const parent = parentFolderPath && parentFolderPath !== "" ? parentFolderPath : "/";
    return `${parent}${base}/`;
  }

  private static zipChildMime(name: string): string {
    const ext = (name.toLowerCase().split(".").pop() || "").trim();
    const M: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ppt: "application/vnd.ms-powerpoint",
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      rtf: "application/rtf",
      json: "application/json",
      html: "text/html",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      tiff: "image/tiff",
      heic: "image/heic",
      svg: "image/svg+xml",
    };
    return M[ext] || "application/octet-stream";
  }

  // Basura de zips (macOS / ocultos) que no debe ingestarse.
  private static zipSkip(entryName: string): boolean {
    const base = entryName.split("/").pop() || "";
    return (
      entryName.startsWith("__MACOSX/") ||
      base === "" ||
      base === ".DS_Store" ||
      base.startsWith("._") ||
      base.startsWith(".")
    );
  }

  // Borra (si existe) la subcarpeta previa del zip y re-extrae el contenido actual.
  // `wipeFolderId` = subcarpeta anterior a arrasar (nueva versión reemplaza todo). Devuelve
  // { count, folderId } — folderId = subcarpeta (para guardar el vínculo en el zip).
  private static async expandZipInto(
    req: Request,
    zipLocalPath: string,
    opts: {
      subfolderFullPath: string;
      brandId: string | null;
      docTier: "GLOBAL" | "RECTOR" | "NORMAL";
      wipeFolderId?: string | null;
    },
  ): Promise<{ count: number; folderId: string | null }> {
    const { subfolderFullPath, brandId, docTier, wipeFolderId } = opts;

    // 1) Arrasar el contenido anterior (subárbol + chunks + físicos), como deleteFolder.
    const prev =
      (wipeFolderId
        ? await prisma.driveFolder.findUnique({ where: { id: wipeFolderId } })
        : null) ?? (await prisma.driveFolder.findFirst({ where: { full_path: subfolderFullPath } }));
    if (prev) {
      const files = await prisma.driveFile.findMany({
        where: { full_path: { startsWith: prev.full_path } },
        select: { id: true, url: true },
      });
      const versions = await prisma.driveFileVersion.findMany({
        where: { file_id: { in: files.map((f) => f.id) } },
        select: { url: true },
      });
      await prisma.driveFolder.delete({ where: { id: prev.id } }); // FK ON DELETE CASCADE
      files.forEach((f) => unlinkPhysical(f.url));
      versions.forEach((v) => unlinkVersionFile(v.url));
    }

    // 2) (Re)crear la subcarpeta vacía.
    const subfolder = await ensureFolderByPath(subfolderFullPath);

    // 3) Extraer cada entrada como archivo real del Drive + ingesta individual.
    let count = 0;
    const zip = new AdmZip(zipLocalPath);
    for (const e of zip.getEntries()) {
      if (e.isDirectory || DriveController.zipSkip(e.entryName)) continue;
      const parts = e.entryName.split("/").filter(Boolean);
      const base = parts[parts.length - 1];
      const internalDir = parts.slice(0, -1).join("/");
      const targetFolder = internalDir
        ? await ensureFolderByPath(`${subfolder.full_path}${internalDir}/`)
        : subfolder;
      const data = e.getData();
      if (!data || data.length === 0) continue;
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}`;
      fs.writeFileSync(path.join(env.UPLOADS_DIR, filename), data);
      const url = `/uploads/${filename}`;
      const mime = DriveController.zipChildMime(base);
      const full_path = `${targetFolder.full_path}${base}`;
      const createdFile = await prisma.driveFile.create({
        data: {
          name: base,
          url,
          mime_type: mime,
          size: data.length,
          folder_id: targetFolder.id,
          brand_id: brandId,
          full_path,
          doc_tier: docTier,
        },
      });
      const version = await prisma.driveFileVersion.create({
        data: {
          file_id: createdFile.id,
          version: 1,
          name: base,
          url,
          mime_type: mime,
          size: data.length,
          uploaded_by: (req as AuthenticatedRequest).user?.id ?? null,
        },
      });
      const withVersion = await prisma.driveFile.update({
        where: { id: createdFile.id },
        data: { current_version_id: version.id, version_count: 1 },
      });
      DriveController.notifyIngest(req, withVersion, version).catch((err) =>
        console.error("[Drive] zip child ingest dispatch failed:", err),
      );
      count++;
    }
    return { count, folderId: subfolder.id };
  }

  // POST webhook to n8n so it can download → Tika → chunk → embed → insert into file_vector_chunks.
  // The chunks are stored against `version_id`, so each version keeps its own vectors and
  // restoring an older version restores what the agent reads.
  private static async notifyIngest(
    req: Request,
    file: { id: string; url: string; full_path: string; mime_type: string; name: string; brand_id: string | null },
    version: { id: string; version: number; url: string; mime_type: string }
  ) {
    if (!env.N8N_BASE_URL) {
      console.warn("[Drive] N8N_BASE_URL not set; skipping ingest webhook.");
      return;
    }
    const base = absoluteBase(req);
    const ingestUrl = `${env.N8N_BASE_URL}/webhook/drive-file-ingest`;

    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
      body: JSON.stringify({
        file_id: file.id,
        version_id: version.id,
        version: version.version,
        url: `${base}${version.url}`, // absolute, so n8n/Tika can fetch it
        full_path: file.full_path,
        mime_type: version.mime_type,
        name: file.name,
        brand_id: file.brand_id,
        callback_url: `${base}/api/drive/callback`,
      }),
    });
    if (!res.ok) {
      console.error(`[Drive] ingest webhook returned ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  // PATCH /drive/files/:id  { name?, folder_id?, brand_id? } — rename, move and/or re-brand.
  // MOVING RE-BRANDS: when the file lands in another folder it adopts that folder's related
  // brand (PKGD at root), unless brand_id is sent explicitly. A pure rename never touches brand.
  static async updateFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, folder_id } = req.body as { name?: string; folder_id?: string | null };
      const brandProvided = Object.prototype.hasOwnProperty.call(req.body, "brand_id");

      const existing = await prisma.driveFile.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ message: "File not found" });
      if (existing.source === "DROPBOX") return res.status(409).json(DROPBOX_READONLY);

      const nextName = name !== undefined ? assertValidName(name) : existing.name;
      const nextFolderId = folder_id !== undefined ? folder_id : existing.folder_id;
      const moved = nextFolderId !== existing.folder_id;

      let folderPath: string | null = null;
      let folderBrandId: string | null = null;
      if (nextFolderId) {
        const folder = await prisma.driveFolder.findUnique({ where: { id: nextFolderId } });
        if (!folder) return res.status(404).json({ message: "Target folder not found" });
        folderPath = folder.full_path;
        folderBrandId = folder.brand_id;
      }

      const nextBrandId: string | null = brandProvided
        ? req.body.brand_id || null
        : moved
          ? folderBrandId ?? (await pkgdBrandId())
          : existing.brand_id;

      const updated = await prisma.driveFile.update({
        where: { id },
        data: {
          name: nextName,
          folder_id: nextFolderId,
          brand_id: nextBrandId,
          full_path: computeFilePath(folderPath, nextName),
        },
      });
      return res.status(200).json(updated);
    } catch (error: any) {
      console.error("Update file error:", error);
      return res.status(error.status || 500).json({ message: error.message || "Failed to update file" });
    }
  }

  // DELETE /drive/files/:id — removes row (cascades versions + chunks) + every version's binary
  static async deleteFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const file = await prisma.driveFile.findUnique({ where: { id } });
      if (!file) return res.status(404).json({ message: "File not found" });
      if (file.source === "DROPBOX") return res.status(409).json(DROPBOX_READONLY);

      // Collect the binaries of the whole history before the cascade drops the rows.
      const versions = await prisma.driveFileVersion.findMany({
        where: { file_id: id },
        select: { url: true },
      });

      await prisma.driveFile.delete({ where: { id } }); // cascades versions + file_vector_chunks
      unlinkPhysical(file.url);
      versions.forEach((v) => unlinkVersionFile(v.url));

      return res.status(200).json({ message: "File deleted", removed_versions: versions.length });
    } catch (error) {
      console.error("Delete file error:", error);
      return res.status(500).json({ message: "Failed to delete file" });
    }
  }

  // GET /drive/files/:id — single file metadata (for the preview modal)
  static async getFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const file = await prisma.driveFile.findUnique({ where: { id } });
      if (!file) return res.status(404).json({ message: "File not found" });
      return res.status(200).json(file);
    } catch (error) {
      console.error("Get file error:", error);
      return res.status(500).json({ message: "Failed to fetch file" });
    }
  }

  // PATCH /drive/files/:id/tier  { doc_tier: "GLOBAL" | "RECTOR" | "NORMAL" }
  // Cambiar la jerarquía es metadato NUESTRO: se permite también en archivos DROPBOX
  // (no muta nada en Dropbox, no desincroniza el espejo).
  static async setTier(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const tier = req.body?.doc_tier;
      if (tier !== "GLOBAL" && tier !== "RECTOR" && tier !== "NORMAL") {
        return res.status(400).json({ message: 'doc_tier debe ser "GLOBAL", "RECTOR" o "NORMAL"' });
      }
      const existing = await prisma.driveFile.findUnique({ where: { id }, select: { id: true } });
      if (!existing) return res.status(404).json({ message: "File not found" });
      const updated = await prisma.driveFile.update({ where: { id }, data: { doc_tier: tier } });
      return res.status(200).json({ id: updated.id, doc_tier: updated.doc_tier });
    } catch (error: any) {
      console.error("Set tier error:", error);
      return res.status(500).json({ message: "Failed to set document tier" });
    }
  }

  // Reconstruye el texto de los docs de un tier (concatenando chunks de la versión vigente),
  // acotado por presupuesto de caracteres. Compartido por /rectores y /globales.
  private static async loadTierDocs(
    where: { doc_tier: "RECTOR" | "GLOBAL"; brand_id?: string },
    charBudget: number,
  ) {
    const files = await prisma.driveFile.findMany({
      where,
      select: { id: true, name: true, full_path: true, url: true, current_version_id: true },
      orderBy: { name: "asc" },
    });
    const docs: Array<{ id: string; name: string; full_path: string; url: string; content: string; truncated: boolean }> = [];
    let used = 0;
    let budgetHit = false;
    for (const f of files) {
      if (used >= charBudget) {
        budgetHit = true;
        break;
      }
      const chunks = await prisma.fileVectorChunk.findMany({
        where: { file_id: f.id, OR: [{ version_id: null }, { version_id: f.current_version_id }] },
        select: { content: true },
        orderBy: { created_at: "asc" },
      });
      let content = chunks.map((c) => c.content).join("\n").trim();
      let truncated = false;
      const remaining = charBudget - used;
      if (content.length > remaining) {
        content = content.slice(0, remaining);
        truncated = true;
        budgetHit = true;
      }
      used += content.length;
      docs.push({ id: f.id, name: f.name, full_path: f.full_path, url: f.url, content, truncated });
    }
    return { docs, used, budgetHit, total: files.length };
  }

  // GET /drive/rectores/:brand_id  (requireAuthOrN8N)
  // Documentos RECTORES de la marca: van SIEMPRE al contexto del agente cuando se habla de ella.
  static async rectores(req: Request, res: Response) {
    try {
      const { brand_id } = req.params;
      const CHAR_BUDGET = 60_000;
      const r = await DriveController.loadTierDocs({ doc_tier: "RECTOR", brand_id }, CHAR_BUDGET);
      return res.status(200).json({
        brand_id,
        count: r.docs.length,
        total_rectores: r.total,
        char_budget: CHAR_BUDGET,
        chars_used: r.used,
        budget_hit: r.budgetHit,
        docs: r.docs,
      });
    } catch (error) {
      console.error("Rectores error:", error);
      return res.status(500).json({ message: "Failed to load rector documents" });
    }
  }

  // GET /drive/globales  (requireAuthOrN8N)
  // Documentos GLOBALES/institucionales (Charter, PKGD Brand Spirit Guide): van SIEMPRE al
  // contexto del agente en TODA sesión, sin gate de marca. Nivel más alto de la cadena.
  static async globales(_req: Request, res: Response) {
    try {
      const CHAR_BUDGET = 60_000;
      const r = await DriveController.loadTierDocs({ doc_tier: "GLOBAL" }, CHAR_BUDGET);
      return res.status(200).json({
        count: r.docs.length,
        total_globales: r.total,
        char_budget: CHAR_BUDGET,
        chars_used: r.used,
        budget_hit: r.budgetHit,
        docs: r.docs,
      });
    } catch (error) {
      console.error("Globales error:", error);
      return res.status(500).json({ message: "Failed to load global documents" });
    }
  }

  // ── Versions ────────────────────────────────────────────
  // Uploading over a file does not overwrite it: it adds a version and points the file at it.
  // Going back/forward only moves that pointer, so nothing is ever lost.

  // GET /drive/files/:id/versions — history (newest first) + which one is current.
  static async listFileVersions(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const file = await prisma.driveFile.findUnique({ where: { id } });
      if (!file) return res.status(404).json({ message: "File not found" });
      const versions = await listVersions(id);
      return res.status(200).json({
        file_id: file.id,
        name: file.name,
        current_version_id: file.current_version_id,
        version_count: file.version_count,
        versions,
      });
    } catch (error) {
      console.error("List versions error:", error);
      return res.status(500).json({ message: "Failed to list versions" });
    }
  }

  // POST /drive/files/:id/versions  (multipart: file + { note? }) — new version, becomes current.
  // The file keeps its Drive name, folder, brand and path: only its content moves forward.
  static async uploadVersion(req: AuthenticatedRequest, res: Response) {
    const upload = req.file;
    try {
      if (!upload) return res.status(400).json({ message: "No file was uploaded" });
      const { id } = req.params;

      const target = await prisma.driveFile.findUnique({ where: { id }, select: { source: true } });
      if (target?.source === "DROPBOX") {
        unlinkVersionFile(`/uploads/${upload.filename}`);
        return res.status(409).json(DROPBOX_READONLY);
      }

      const version = await addVersion(id, upload, {
        note: (req.body?.note as string) ?? null,
        uploaded_by: req.user?.id ?? null,
      });
      const file = (await prisma.driveFile.findUnique({ where: { id } }))!;

      // A new version means new content: its own vectors, and the old preview is not it.
      DriveController.forgetPreview(version.id);

      // ZIP: no se vectoriza. La versión nueva REEMPLAZA todo — se arrasa la subcarpeta
      // extraída anterior (por el vínculo zip_expanded_folder_id) y se re-extrae del nuevo zip.
      if (DriveController.isZipFile(file.name, file.mime_type)) {
        const parentFolder = file.folder_id
          ? await prisma.driveFolder.findUnique({
              where: { id: file.folder_id },
              select: { full_path: true },
            })
          : null;
        const subfolderFullPath = DriveController.zipSubfolderPath(
          parentFolder?.full_path ?? "/",
          file.name,
        );
        const newZipPath = path.join(env.UPLOADS_DIR, path.basename(version.url));
        const { count, folderId } = await DriveController.expandZipInto(req, newZipPath, {
          subfolderFullPath,
          brandId: file.brand_id,
          docTier: (file.doc_tier as "GLOBAL" | "RECTOR" | "NORMAL") ?? "NORMAL",
          wipeFolderId: (file as any).zip_expanded_folder_id ?? null,
        });
        const linked = await prisma.driveFile.update({
          where: { id: file.id },
          data: { zip_expanded_folder_id: folderId },
        });
        return res.status(201).json({ file: linked, version, expanded_files: count });
      }

      DriveController.notifyIngest(req, file, version).catch((e) =>
        console.error("[Drive] ingest webhook dispatch failed:", e)
      );

      return res.status(201).json({ file, version });
    } catch (error: any) {
      if (upload) unlinkVersionFile(`/uploads/${upload.filename}`);
      if (error instanceof VersionError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Upload version error:", error);
      return res.status(500).json({ message: "Failed to upload new version" });
    }
  }

  // POST /drive/files/:id/versions/:versionId/current — go back (or forward) to a version.
  // Non-destructive: the history stays intact and the agent's search follows the pointer.
  static async restoreVersion(req: AuthenticatedRequest, res: Response) {
    try {
      const { id, versionId } = req.params;
      const { file, version } = await setCurrentVersion(id, versionId);
      return res.status(200).json({ file, version });
    } catch (error: any) {
      if (error instanceof VersionError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Restore version error:", error);
      return res.status(500).json({ message: "Failed to restore version" });
    }
  }

  // DELETE /drive/files/:id/versions/:versionId — prune history (never the current version).
  static async deleteFileVersion(req: AuthenticatedRequest, res: Response) {
    try {
      const { id, versionId } = req.params;
      const result = await deleteVersion(id, versionId);
      DriveController.forgetPreview(versionId);
      return res.status(200).json({ message: "Version deleted", ...result });
    } catch (error: any) {
      if (error instanceof VersionError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Delete version error:", error);
      return res.status(500).json({ message: "Failed to delete version" });
    }
  }

  // GET /drive/files/:id/preview[?version=<version_id>] — sanitized HTML for formats the
  // browser cannot open natively (docx, xlsx, pptx, odt, rtf, …), converted by Tika.
  // Without ?version it renders the current version. The cache is keyed by VERSION id:
  // a version's bytes never change, so a hit is always valid.
  static async previewFile(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const requestedVersion = (req.query.version as string) || null;

      const file = await prisma.driveFile.findUnique({ where: { id } });
      if (!file) return res.status(404).json({ message: "File not found" });

      // Which bytes to convert: the asked-for version, else the current one, else the
      // file row itself (a pre-versioning row that somehow has no version).
      let source = { url: file.url, name: file.name, mime: file.mime_type, key: file.current_version_id ?? id };
      const versionId = requestedVersion ?? file.current_version_id;
      if (versionId) {
        const version = await prisma.driveFileVersion.findUnique({ where: { id: versionId } });
        if (!version || version.file_id !== id) {
          return res.status(404).json({ message: "Version not found for this file" });
        }
        source = { url: version.url, name: version.name, mime: version.mime_type, key: version.id };
      }

      const cached = DriveController.previewCache.get(source.key);
      if (cached) {
        return res.status(200).json({ id, version_id: versionId, html: cached, cached: true });
      }
      if (!isConvertible(source.mime, source.name)) {
        return res.status(415).json({ message: "No HTML preview for this file type" });
      }

      // Archivos de Dropbox: el binario no vive en /uploads. Se descarga de forma efímera
      // (no se persiste) y se convierte a HTML por Tika desde memoria.
      let html: string;
      if (file.source === "DROPBOX") {
        if (!file.dropbox_id) return res.status(404).json({ message: "Dropbox file id missing" });
        const { buffer } = await dropboxDownload(file.dropbox_id);
        html = await renderPreviewHtmlFromBuffer(buffer, source.name);
      } else {
        html = await renderPreviewHtml(source.url, source.name);
      }
      DriveController.rememberPreview(source.key, html);
      return res.status(200).json({ id, version_id: versionId, html, cached: false });
    } catch (error: any) {
      if (error instanceof DropboxError) {
        return res.status(error.status || 502).json({
          message: "No se pudo obtener la vista previa desde Dropbox en este momento.",
        });
      }
      if (error instanceof PreviewError) {
        console.error(`[Drive] preview failed for ${req.params.id}:`, error.message);
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Preview file error:", error);
      return res.status(500).json({ message: "Failed to render preview" });
    }
  }

  // Bounded FIFO cache (version id → html). Conversions are CPU-heavy in Tika and a
  // version's bytes never change, so re-opening a document is free.
  private static previewCache = new Map<string, string>();
  private static readonly PREVIEW_CACHE_MAX = 40;
  private static forgetPreview(key: string) {
    DriveController.previewCache.delete(key);
  }
  private static rememberPreview(id: string, html: string) {
    if (DriveController.previewCache.size >= DriveController.PREVIEW_CACHE_MAX) {
      const oldest = DriveController.previewCache.keys().next().value;
      if (oldest) DriveController.previewCache.delete(oldest);
    }
    DriveController.previewCache.set(id, html);
  }

  // Propagate a new related brand to a folder subtree. Only rows that still carry `oldBrand`
  // (i.e. were inheriting it) are updated; rows with a distinct explicit brand are left intact.
  private static async rebrandSubtree(
    rootFullPath: string,
    oldBrand: string | null,
    newBrand: string | null,
  ): Promise<void> {
    const like = rootFullPath + "%";
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE drive_folders
        SET brand_id = ${newBrand}::uuid, updated_at = now()
        WHERE full_path LIKE ${like} AND brand_id IS NOT DISTINCT FROM ${oldBrand}::uuid
      `,
      prisma.$executeRaw`
        UPDATE drive_files
        SET brand_id = ${newBrand}::uuid
        WHERE full_path LIKE ${like} AND brand_id IS NOT DISTINCT FROM ${oldBrand}::uuid
      `,
    ]);
  }

  // ── Structural map ──────────────────────────────────────

  // GET /drive/tree — WHOLE unified tree (the Drive is one shared space; folders carry an
  // optional related brand). Used by the UI.
  // Query opcional (usada por la herramienta del agente para NO volcar todo el Drive):
  //   ?files=false   → solo el esqueleto de carpetas (omite los archivos)
  //   ?depth=N       → limita la profundidad de carpetas (N niveles desde la raíz)
  //   ?path=/pref/   → solo el subárbol bajo esa ruta (para "bajar" a una carpeta)
  static async treeAll(req: Request, res: Response) {
    const deptCtx = await resolveDepartmentContext(req);
    return DriveController.buildTree(
      res,
      undefined,
      DriveController.parseTreeOpts(req),
      deptCtx,
      DriveController.resolveManageContext(req),
    );
  }

  // GET /drive/tree/:brand_id — tree filtered by related brand (used by the n8n agent tool).
  static async tree(req: Request, res: Response) {
    const deptCtx = await resolveDepartmentContext(req);
    return DriveController.buildTree(
      res,
      req.params.brand_id,
      DriveController.parseTreeOpts(req),
      deptCtx,
      DriveController.resolveManageContext(req),
    );
  }

  // Who may MOVE/RENAME/DELETE in the Drive UI: admins everywhere, department leaders
  // inside their department's anchored subtree (except /EXTERNAL DOWNLOADS). Mirrors
  // requireFolderManager/requireFileManager so the UI only shows controls that will succeed.
  private static resolveManageContext(
    req: Request,
  ): { isAdmin: boolean; isLeader: boolean; leaderDepartmentIds: string[] } | null {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return null; // n8n/agent token: no UI management.
    return {
      isAdmin: user.global_role === "admin",
      isLeader: ((user as any).departments ?? []).some((d: any) => d.is_leader),
      leaderDepartmentIds: ((user as any).departments ?? [])
        .filter((d: any) => d.is_leader)
        .map((d: any) => d.department_id),
    };
  }

  private static parseTreeOpts(req: Request): { includeFiles: boolean; depth: number | null; path: string | null } {
    // El agente (token n8n) no debe recibir el Drive entero: por defecto le damos SOLO el
    // esqueleto de carpetas hasta 3 niveles (~50KB en vez de ~2.4MB), lo que evita reventar
    // el context window del modelo. La UI (JWT de operador) sigue recibiendo el árbol completo.
    // Cualquier parámetro explícito (?files=/?depth=/?path=) tiene prioridad para ambos.
    const isAgent = req.headers["x-n8n-token"] === env.N8N_SECRET_TOKEN;
    const hasFiles = req.query.files !== undefined;
    const hasDepth = req.query.depth !== undefined;

    const includeFiles = hasFiles ? req.query.files !== "false" : !isAgent;
    const depthRaw = parseInt((req.query.depth as string) || "", 10);
    const depth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : isAgent && !hasDepth ? 3 : null;
    const path = typeof req.query.path === "string" && req.query.path ? req.query.path : null;
    return { includeFiles, depth, path };
  }

  // Shared builder. `brandFilter` undefined => everything; otherwise scoped to that related brand.
  // `opts` acota el resultado (ver parseTreeOpts). Defaults = árbol completo (comportamiento previo).
  private static async buildTree(
    res: Response,
    brandFilter: string | undefined,
    opts: { includeFiles: boolean; depth: number | null; path: string | null } = {
      includeFiles: true,
      depth: null,
      path: null,
    },
    deptCtx: DepartmentContext | null = null,
    manageCtx: { isAdmin: boolean; isLeader: boolean; leaderDepartmentIds: string[] } | null = null,
  ) {
    try {
      const where: any = brandFilter ? { brand_id: brandFilter } : {};
      if (opts.path) where.full_path = { startsWith: opts.path };

      const [foldersRawAll, filesRawAll, brands, folderDepts] = await Promise.all([
        prisma.driveFolder.findMany({
          where,
          select: { id: true, name: true, parent_id: true, full_path: true, brand_id: true, source: true },
          orderBy: { full_path: "asc" },
        }),
        opts.includeFiles
          ? prisma.driveFile.findMany({
          where,
          select: {
            id: true,
            name: true,
            folder_id: true,
            full_path: true,
            mime_type: true,
            url: true,
            brand_id: true,
            // The UI badges files that carry history and opens the preview on the current version.
            version_count: true,
            current_version_id: true,
            // LOCAL vs DROPBOX: the UI hides the version manager and shows a "Dropbox" badge.
            source: true,
            // RECTOR vs NORMAL: the UI shows a "Rector" badge and the tier toggle.
            doc_tier: true,
          },
          orderBy: { name: "asc" },
            })
          : Promise.resolve([] as any[]),
        prisma.brand.findMany({ select: { id: true, name: true } }),
        DriveController.loadFolderDepartments(),
      ]);
      const brandName = new Map(brands.map((b) => [b.id, b.name]));
      const { deptByFolder, restricted } = folderDepts;

      // ¿Puede el usuario GESTIONAR (mover/renombrar/borrar) esta carpeta? Espeja exactamente
      // requireFolderManager: admin en todo; líder solo en el subárbol anclado a SU depto;
      // /EXTERNAL DOWNLOADS solo admin. La UI usa esto para mostrar/ocultar editar y borrar.
      const canManageFolderPath = (fullPath: string): boolean => {
        if (!manageCtx) return false;
        if (manageCtx.isAdmin) return true;
        if (!manageCtx.isLeader || !manageCtx.leaderDepartmentIds.length) return false;
        const p = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
        if (p === "/EXTERNAL DOWNLOADS" || p.startsWith("/EXTERNAL DOWNLOADS/")) return false;
        const target = fullPath.endsWith("/") ? fullPath : `${fullPath}/`;
        return restricted.some((r) => {
          if (!manageCtx.leaderDepartmentIds.some((id) => r.depts.has(id))) return false;
          const anchor = r.full_path.endsWith("/") ? r.full_path : `${r.full_path}/`;
          return target === anchor || target.startsWith(anchor);
        });
      };

      // Department visibility gate: drop folders the caller may not see, and their whole
      // subtree (files included). Admins / unresolved context (agent w/o user_id) => no denial.
      const denied = DriveController.deniedPrefixes(restricted, deptCtx);
      const foldersRaw = denied.length
        ? foldersRawAll.filter((f) => !DriveController.isHiddenPath(f.full_path, denied))
        : foldersRawAll;
      const filesRaw = denied.length
        ? filesRawAll.filter((f: any) => !DriveController.isHiddenPath(f.full_path, denied))
        : filesRawAll;

      // Acotar por profundidad: conserva carpetas hasta `depth` niveles; los archivos solo
      // si su carpeta sobrevivió (o son de raíz). Esto evita volcar todo el Drive al agente.
      const depthOf = (fp: string) => fp.split("/").filter(Boolean).length;
      const folders = opts.depth ? foldersRaw.filter((f) => depthOf(f.full_path) <= opts.depth!) : foldersRaw;
      const keptFolderIds = new Set(folders.map((f) => f.id));
      const files = opts.depth
        ? filesRaw.filter((f: any) => !f.folder_id || keptFolderIds.has(f.folder_id))
        : filesRaw;

      type FileNode = {
        id: string;
        name: string;
        type: "file";
        full_path: string;
        mime_type: string;
        url: string;
        brand_id: string | null;
        brand_name: string | null;
        version_count: number;
        current_version_id: string | null;
        source: string;
        doc_tier: string;
        // ¿El usuario actual puede mover/borrar este archivo? (admin o líder del depto de su carpeta)
        can_manage: boolean;
      };
      type Node = {
        id: string;
        name: string;
        type: "folder";
        full_path: string;
        brand_id: string | null;
        brand_name: string | null;
        source: string;
        // Departamentos a los que está anclada (visibilidad). [] = visible para todos.
        department_ids: string[];
        // ¿El usuario actual puede mover/renombrar/borrar esta carpeta?
        can_manage: boolean;
        folders: Node[];
        files: FileNode[];
      };
      const byId = new Map<string, Node>();
      const roots: Node[] = [];

      for (const f of folders) {
        byId.set(f.id, {
          id: f.id,
          name: f.name,
          type: "folder",
          full_path: f.full_path,
          brand_id: f.brand_id,
          brand_name: f.brand_id ? brandName.get(f.brand_id) ?? null : null,
          source: f.source,
          department_ids: deptByFolder.get(f.id) ?? [],
          can_manage: canManageFolderPath(f.full_path),
          folders: [],
          files: [],
        });
      }
      for (const f of folders) {
        const node = byId.get(f.id)!;
        if (f.parent_id && byId.has(f.parent_id)) byId.get(f.parent_id)!.folders.push(node);
        else roots.push(node);
      }
      const rootFiles: FileNode[] = [];
      for (const file of files) {
        const parentNode = file.folder_id ? byId.get(file.folder_id) : undefined;
        // Un archivo hereda el permiso de gestión de su carpeta; en la raíz (sin carpeta) solo admin.
        const fileCanManage = parentNode ? parentNode.can_manage : Boolean(manageCtx?.isAdmin);
        const entry: FileNode = {
          id: file.id,
          name: file.name,
          type: "file",
          full_path: file.full_path,
          mime_type: file.mime_type,
          url: file.url,
          brand_id: file.brand_id,
          brand_name: file.brand_id ? brandName.get(file.brand_id) ?? null : null,
          version_count: file.version_count,
          current_version_id: file.current_version_id,
          source: file.source,
          doc_tier: file.doc_tier,
          can_manage: fileCanManage,
        };
        if (parentNode) parentNode.files.push(entry);
        else rootFiles.push(entry);
      }

      return res.status(200).json({
        brand_id: brandFilter ?? null,
        folder_count: folders.length,
        file_count: files.length,
        tree: { folders: roots, files: rootFiles },
      });
    } catch (error) {
      console.error("Drive tree error:", error);
      return res.status(500).json({ message: "Failed to build drive tree" });
    }
  }

  // POST /drive/callback — n8n reports ingest progress/result (requireN8N).
  static async callback(req: Request, res: Response) {
    try {
      const { file_id, status, chunks } = req.body as {
        file_id?: string;
        status?: string;
        chunks?: number;
      };
      if (!file_id) return res.status(400).json({ message: "file_id is required" });

      const file = await prisma.driveFile.findUnique({ where: { id: file_id } });
      if (!file) return res.status(404).json({ message: "File not found" });

      console.log(`[Drive] ingest callback for ${file_id}: status=${status}, chunks=${chunks ?? "?"}`);
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Drive callback error:", error);
      return res.status(500).json({ message: "Failed to process callback" });
    }
  }
}
