import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { KnowledgeController } from "../controllers/knowledge.controller.js";
import { requireAuth, requireAdmin, requireN8N } from "../middlewares/auth.middleware.js";

const router = Router();

// Setup multer storage for document ingestion
const uploadDir = "/Users/MiguelMedina/Desktop/Miguel/PKGD/develop/pkgdos-back/uploads";
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
router.post("/extract", requireAuth, requireAdmin, KnowledgeController.extractGold);
router.get("/:brand_id", requireAuth, KnowledgeController.listByBrand);
router.get("/:id/download", requireAuth, KnowledgeController.download);
router.patch("/:id/status", requireN8N, KnowledgeController.statusWebhook);
router.post("/callback", KnowledgeController.callback);
router.delete("/:id", requireAuth, requireAdmin, KnowledgeController.delete);
router.patch("/:id/brand", requireAuth, requireAdmin, KnowledgeController.updateBrand);

export default router;
