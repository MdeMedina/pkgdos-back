import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { DriveController } from "../controllers/drive.controller.js";
import { requireAuth, requireN8N, requireAuthOrN8N } from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

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
router.patch("/folders/:id", requireAuth, DriveController.updateFolder);
router.delete("/folders/:id", requireAuth, DriveController.deleteFolder);
router.get("/folders/:brand_id/contents", requireAuth, DriveController.listContents);

// ── Files ────────────────────────────────────────────────
router.post("/upload", requireAuth, uploadMiddleware.single("file"), DriveController.upload);
router.patch("/files/:id", requireAuth, DriveController.updateFile);
router.delete("/files/:id", requireAuth, DriveController.deleteFile);
router.get("/files/:id", requireAuth, DriveController.getFile);
// Sanitized HTML preview for office formats (docx/xlsx/pptx/odt/rtf/…) via Tika.
router.get("/files/:id/preview", requireAuth, DriveController.previewFile);

// ── AI map + ingest callback ─────────────────────────────
// GET /drive/tree — whole unified tree for the UI (Drive is one shared space).
router.get("/tree", requireAuthOrN8N, DriveController.treeAll);
// GET /drive/tree/:brand_id — brand-filtered tree consumed by the n8n agent tool (Explorar_Archivos).
// Dual auth: Bearer JWT (operator) or x-n8n-token (agent service).
router.get("/tree/:brand_id", requireAuthOrN8N, DriveController.tree);
// Agent write ops (create folder / move file) — additive only, no delete.
router.post("/agent/manage", requireN8N, DriveController.agentManage);
router.post("/callback", requireN8N, DriveController.callback);

export default router;
