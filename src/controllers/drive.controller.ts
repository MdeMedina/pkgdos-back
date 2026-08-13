import { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
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

      return res.status(200).json({ folders, files });
    } catch (error) {
      console.error("List contents error:", error);
      return res.status(500).json({ message: "Failed to list folder contents" });
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
    return DriveController.buildTree(res, undefined, DriveController.parseTreeOpts(req));
  }

  // GET /drive/tree/:brand_id — tree filtered by related brand (used by the n8n agent tool).
  static async tree(req: Request, res: Response) {
    return DriveController.buildTree(res, req.params.brand_id, DriveController.parseTreeOpts(req));
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
    }
  ) {
    try {
      const where: any = brandFilter ? { brand_id: brandFilter } : {};
      if (opts.path) where.full_path = { startsWith: opts.path };

      const [foldersRaw, filesRaw, brands] = await Promise.all([
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
      ]);
      const brandName = new Map(brands.map((b) => [b.id, b.name]));

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
      };
      type Node = {
        id: string;
        name: string;
        type: "folder";
        full_path: string;
        brand_id: string | null;
        brand_name: string | null;
        source: string;
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
        };
        if (file.folder_id && byId.has(file.folder_id)) byId.get(file.folder_id)!.files.push(entry);
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
