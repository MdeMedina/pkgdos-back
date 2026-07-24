import fs from "node:fs";
import path from "node:path";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";

/**
 * Files a knowledge asset's concept .docx into the internal Drive tree, under
 * /Branding/<marca>/<sub>/ (sub = "Propuesta" | "Oro" | "Joya").
 *
 * The asset's concept already lives in pgvector (document_chunks) via the
 * knowledge pipeline; the Drive file registered here is the downloadable
 * artifact only — it is NOT re-ingested into file_vector_chunks.
 */

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type BrandingSub = "Propuesta" | "Oro" | "Joya";

/** Sanitize a segment so it can't corrupt the materialized path. */
function safeSegment(name: string): string {
  return (name ?? "").replace(/\//g, "-").trim();
}

/**
 * Find (or create) a folder by (parent_id, name). Root folders have parent_id=null.
 * Returns the folder row.
 */
async function findOrCreateFolder(
  name: string,
  parentId: string | null,
  brandId: string | null,
  parentFullPath: string | null
) {
  const clean = safeSegment(name);
  const existing = await prisma.driveFolder.findFirst({
    where: { name: clean, parent_id: parentId },
  });
  if (existing) return existing;

  const full_path = `${parentFullPath ?? ""}${clean}/`; // parentFullPath already ends in "/"
  return prisma.driveFolder.create({
    data: { name: clean, parent_id: parentId, brand_id: brandId, full_path },
  });
}

/** Cached PKGD brand id (root org folders relate to PKGD). */
let pkgdBrandIdCache: string | null = null;
async function pkgdBrandId(): Promise<string | null> {
  if (pkgdBrandIdCache) return pkgdBrandIdCache;
  const brand = await prisma.brand.findFirst({ where: { name: "PKGD" }, select: { id: true } });
  pkgdBrandIdCache = brand?.id ?? null;
  return pkgdBrandIdCache;
}

/**
 * Ensure /Branding/ -> /Branding/<marca>/ -> /Branding/<marca>/<sub>/ exist and
 * return the leaf (sub) folder. The /Branding/ root relates to PKGD; the brand
 * folder and its children relate to the brand itself (matches existing convention).
 */
export async function ensureBrandingSubfolder(
  brandName: string,
  brandId: string,
  sub: BrandingSub
) {
  const pkgd = await pkgdBrandId();
  const branding = await findOrCreateFolder("Branding", null, pkgd, "/");
  const brandFolder = await findOrCreateFolder(
    brandName,
    branding.id,
    brandId,
    branding.full_path
  );
  return findOrCreateFolder(sub, brandFolder.id, brandId, brandFolder.full_path);
}

/** Build the concept .docx buffer for an asset (title + type/brand line + chunks). */
async function buildAssetDocx(asset: {
  title: string;
  asset_type: string;
  brand?: { name: string } | null;
  chunks: { content: string }[];
}): Promise<Buffer> {
  const concept = asset.chunks.map((c) => c.content).join("\n\n").trim();
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

  const bodyParagraphs = (concept || "Sin contenido.")
    .split(/\n{2,}/)
    .map(
      (block) =>
        new Paragraph({
          children: block
            .split("\n")
            .map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined })),
        })
    );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: asset.title, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun({
                italics: true,
                text: `${asset.asset_type} · ${asset.brand?.name ?? "Sin marca"}`,
              }),
            ],
          }),
          new Paragraph({ text: "" }),
          ...bodyParagraphs,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as unknown as Buffer;
}

/**
 * Generate the asset's .docx, persist source_file_url, and register it as a
 * drive_files row under /Branding/<marca>/<sub>/. Idempotent per (folder, name):
 * re-filing replaces the previous same-named row. When move=true, also removes
 * the asset's doc from /Branding/<marca>/Propuesta/ (proposal -> approved).
 *
 * Returns the created drive_files full_path, or null when it can't be filed
 * (no brand). NEVER throws to callers that wrap it — filing is best-effort.
 */
export async function placeAssetInBranding(
  assetId: string,
  sub: BrandingSub,
  opts: { move?: boolean } = {}
): Promise<string | null> {
  const asset = await prisma.knowledgeAsset.findUnique({
    where: { id: assetId },
    include: { chunks: { orderBy: { id: "asc" } }, brand: true },
  });
  if (!asset) throw Object.assign(new Error("Knowledge asset not found"), { status: 404 });
  if (!asset.brand_id || !asset.brand) {
    // /Branding lives under a marca; a brandless asset has nowhere to go.
    console.warn(`[Drive] asset ${assetId} has no brand; skipping Drive filing.`);
    return null;
  }

  // 1) Render + persist the .docx on disk (served at /uploads).
  const buffer = await buildAssetDocx(asset);
  const safe = asset.title.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60) || "concepto";
  const filename = `${Date.now()}-${safe}.docx`;
  if (!fs.existsSync(env.UPLOADS_DIR)) fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.UPLOADS_DIR, filename), buffer);
  const url = `/uploads/${filename}`;
  await prisma.knowledgeAsset.update({ where: { id: assetId }, data: { source_file_url: url } });

  // 2) Ensure the target folder and register the file (deterministic name => idempotent).
  const folder = await ensureBrandingSubfolder(asset.brand.name, asset.brand_id, sub);
  const docName = `${safeSegment(asset.title).slice(0, 80) || "Concepto"}.docx`;
  const full_path = `${folder.full_path}${docName}`;

  await prisma.driveFile.deleteMany({ where: { folder_id: folder.id, name: docName } });

  // 3) On approval, "move" out of Propuesta (delete the proposal's row).
  if (opts.move) {
    const propuesta = await prisma.driveFolder.findFirst({
      where: { brand_id: asset.brand_id, full_path: `/Branding/${safeSegment(asset.brand.name)}/Propuesta/` },
    });
    if (propuesta) {
      await prisma.driveFile.deleteMany({ where: { folder_id: propuesta.id, name: docName } });
    }
  }

  await prisma.driveFile.create({
    data: {
      name: docName,
      url,
      mime_type: DOCX_MIME,
      size: buffer.length,
      folder_id: folder.id,
      brand_id: asset.brand_id,
      full_path,
    },
  });

  return full_path;
}
