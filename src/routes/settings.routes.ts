import { Router } from "express";
import { SettingsController } from "../controllers/settings.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

// Secciones marcadas como "página de laboratorio" (claves = `to` del nav).
// GET: cualquier usuario autenticado (el shell filtra su propio nav con esto).
router.get("/lab-sections", requireAuth, SettingsController.getLabSections);
// PUT: solo el dueño del laboratorio (guard por is_lab_owner dentro del controlador).
router.put("/lab-sections", requireAuth, SettingsController.setLabSections);

export default router;
