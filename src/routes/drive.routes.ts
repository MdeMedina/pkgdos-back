import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { DriveController } from "../controllers/drive.controller.js";
import {
  requireAuth,
  requireAdmin,
  requireN8N,
  requireAuthOrN8N,
  requireBrandMembership,
  requireDriveFileBrandMembership,
  requireDriveFolderBrandMembership,
} from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

// Brand id taken from the URL for brand-scoped list/tree endpoints.
const brandFromParam = (req: any) => req.params.brand_id as string | undefined;

const router = Router();

// Reuse the same uploads dir / disk storage strategy as the knowledge pipeline.
const uploadDir = env.UPLOADS_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});
const uploadMiddleware = multer({ storage });

// ── Folders ──────────────────────────────────────────────
router.post("/folders", requireAuth, DriveController.createFolder);
router.patch("/folders/:id", requireAuth, requireDriveFolderBrandMembership, DriveController.updateFolder);
// Deleting a folder wipes its whole subtree: admin + brand membership of the folder.
router.delete("/folders/:id", requireAuth, requireDriveFolderBrandMembership, requireAdmin, DriveController.deleteFolder);
router.get(
  "/folders/:brand_id/contents",
  requireAuth,
  requireBrandMembership(brandFromParam),
  DriveController.listContents,
);
// Anclar la carpeta a 0..N departamentos (visibilidad). Admin + membresía de marca de la carpeta.
// Body: { department_ids: string[] }. [] = visible para todos.
router.put(
  "/folders/:id/departments",
  requireAuth,
  requireDriveFolderBrandMembership,
  requireAdmin,
  DriveController.setFolderDepartments,
);

// ── Files ────────────────────────────────────────────────
router.post("/upload", requireAuth, uploadMiddleware.single("file"), DriveController.upload);
// Move / re-brand: require membership of the file's current brand.
router.patch("/files/:id", requireAuth, requireDriveFileBrandMembership, DriveController.updateFile);
// Delete: admin + brand membership of the file.
router.delete("/files/:id", requireAuth, requireDriveFileBrandMembership, requireAdmin, DriveController.deleteFile);
router.get("/files/:id", requireAuth, requireDriveFileBrandMembership, DriveController.getFile);
// Cambiar jerarquía Rector/Normal (metadato del agente). Permitido también en archivos DROPBOX.
// setTier changes what the agent always injects → admin + brand membership.
router.patch("/files/:id/tier", requireAuth, requireDriveFileBrandMembership, requireAdmin, DriveController.setTier);
// Sanitized HTML preview for office formats (docx/xlsx/pptx/odt/rtf/…) via Tika.
// ?version=<version_id> previews a point in the history instead of the current version.
router.get("/files/:id/preview", requireAuth, requireDriveFileBrandMembership, DriveController.previewFile);

// ── Versions ─────────────────────────────────────────────
// Uploading over a file adds a version and points the file at it; going back/forward only
// moves that pointer, so the history (and the agent's view of it) is never destroyed.
router.get("/files/:id/versions", requireAuth, DriveController.listFileVersions);
router.post(
  "/files/:id/versions",
  requireAuth,
  uploadMiddleware.single("file"),
  DriveController.uploadVersion,
);
router.post("/files/:id/versions/:versionId/current", requireAuth, DriveController.restoreVersion);
router.delete("/files/:id/versions/:versionId", requireAuth, DriveController.deleteFileVersion);

// ── AI map + ingest callback ─────────────────────────────
// GET /drive/tree — whole unified tree for the UI (Drive is one shared space).
router.get("/tree", requireAuthOrN8N, DriveController.treeAll);
// GET /drive/tree/:brand_id — brand-filtered tree consumed by the n8n agent tool (Explorar_Archivos).
// Dual auth: Bearer JWT (operator) or x-n8n-token (agent service).
// Brand gate: operator must belong to :brand_id; when called with the n8n token the
// request MUST include ?user_id=<operator> so membership is checked for that operator.
router.get("/tree/:brand_id", requireAuthOrN8N, requireBrandMembership(brandFromParam), DriveController.tree);
// GET /drive/rectores/:brand_id — documentos RECTORES de la marca (siempre al contexto del agente).
// Dual auth: operador (UI, para revisarlos) o token n8n (el flujo los inyecta en cada turno).
// Same brand gate as /tree/:brand_id (n8n must send ?user_id=<operator>).
router.get("/rectores/:brand_id", requireAuthOrN8N, requireBrandMembership(brandFromParam), DriveController.rectores);
// GET /drive/globales — documentos GLOBALES/institucionales (Charter, PKGD guide): siempre, sin marca.
router.get("/globales", requireAuthOrN8N, DriveController.globales);
// Agent write ops (create folder / move file) — additive only, no delete.
router.post("/agent/manage", requireN8N, DriveController.agentManage);
router.post("/callback", requireN8N, DriveController.callback);

export default router;
