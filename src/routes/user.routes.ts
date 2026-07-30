import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { UserController } from "../controllers/user.controller.js";
import { UserProfileController } from "../controllers/user-profile.controller.js";
import { requireAuth, requireAdmin, requireN8N } from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

const router = Router();

// Mismo destino que el resto de subidas (volumen persistente ./uploads).
const uploadDir = env.UPLOADS_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const profileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
  }),
  // Un about me es una página, no un expediente: 10 MB sobra y acota el abuso.
  limits: { fileSize: 10 * 1024 * 1024 },
});

// El about me del propio operador. Antes de "/:id" para que no lo capture esa ruta.
router.get("/me/profile", requireAuth, UserProfileController.getMine);
router.post("/me/profile", requireAuth, profileUpload.single("file"), UserProfileController.uploadMine);
router.delete("/me/profile", requireAuth, UserProfileController.deleteMine);
// Lo consume el agente en cada turno (n8n), no la UI.
router.get("/:id/profile-injection", requireN8N, UserProfileController.injection);

router.get("/", requireAuth, requireAdmin, UserController.list);
router.post("/", requireAuth, requireAdmin, UserController.create);
router.patch("/:id", requireAuth, requireAdmin, UserController.update);
router.delete("/:id", requireAuth, requireAdmin, UserController.delete);
router.get("/:id/diagnostic", requireAuth, requireAdmin, UserController.getDiagnostic);

export default router;
