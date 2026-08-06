import { Router } from "express";
import { DropboxController } from "../controllers/dropbox.controller.js";
import { requireAuth, requireN8N } from "../middlewares/auth.middleware.js";

const router = Router();

// Webhook de Dropbox — PÚBLICO por diseño: GET responde el challenge de verificación y
// POST se autentica con la firma HMAC del cuerpo (no con JWT), que Dropbox incluye.
router.get("/webhook", DropboxController.verify);
router.post("/webhook", DropboxController.notify);

// "Enlace invisible": redirige a un enlace temporal fresco. Público como /uploads
// (el id es un UUID no adivinable) para que <img>/<iframe> lo carguen sin cabeceras.
router.get("/raw/:id", DropboxController.raw);

// Operación de servicio: bootstrap / reconciliación manual (token de servicio n8n).
router.post("/sync", requireN8N, DropboxController.sync);

// Estado de la sincronización para la UI (banner, último error, conteos).
router.get("/status", requireAuth, DropboxController.status);

export default router;
