import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { KnowledgeController } from "../controllers/knowledge.controller.js";
import {
  requireAuth,
  requireAdmin,
  requireN8N,
  requireBrandMembership,
} from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

const router = Router();

// Setup multer storage for document ingestion
const uploadDir = env.UPLOADS_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  }
});

const uploadMiddleware = multer({ storage });

router.get("/", requireAuth, requireAdmin, KnowledgeController.listAll);
router.post("/upload", requireAuth, requireAdmin, uploadMiddleware.single("file"), KnowledgeController.upload);
router.get("/external", requireAuth, KnowledgeController.listExternal);
// DG o el líder del área aprueban el Oro de una sesión (el alcance se valida en el
// controlador, que ya carga la propuesta). Debe preceder a "/:brand_id".
router.post("/session/:session_id/approve", requireAuth, KnowledgeController.approveBySession);
// Ídem para la Joya (botón de aprobar dentro de la conversación).
router.post("/session/:session_id/approve-jewel", requireAuth, KnowledgeController.approveSessionJewel);
// Propuestas pendientes, filtradas por área según quién pregunta. DEBE ir antes
// de "/:brand_id" para que esa ruta no se la trague.
router.get("/proposals", requireAuth, KnowledgeController.listProposals);
router.get(
  "/:brand_id",
  requireAuth,
  requireBrandMembership((req) => req.params.brand_id),
  KnowledgeController.listByBrand,
);
router.get("/department/:department_id", requireAuth, KnowledgeController.listByDepartment);
// download validates the asset's brand membership inside the controller (it also
// handles the Gold/session-transcript case that has no source file).
router.get("/:id/download", requireAuth, KnowledgeController.download);
router.patch("/:id/status", requireN8N, KnowledgeController.statusWebhook);
// DG o el líder del área aprueban -> dispara el flujo de aprobación en n8n.
router.post("/:id/approve", requireAuth, KnowledgeController.approve);
// n8n asks the backend to render the concept .docx into uploads (multer dir).
router.post("/:id/generate-doc", requireN8N, KnowledgeController.generateDoc);
// n8n files a fresh proposal's .docx into /Branding/<marca>/Propuesta/.
router.post("/:id/file-proposal", requireN8N, KnowledgeController.fileProposal);
router.post("/callback", requireN8N, KnowledgeController.callback);
router.delete("/:id", requireAuth, requireAdmin, KnowledgeController.delete);
router.patch("/:id/brand", requireAuth, requireAdmin, KnowledgeController.updateBrand);

export default router;
