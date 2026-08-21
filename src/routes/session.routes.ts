import { Router } from "express";
import { SessionController } from "../controllers/session.controller.js";
import {
  requireAuth,
  requireAdmin,
  requireN8N,
  requireSessionOwner,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/my-sessions", requireAuth, SessionController.mySessions);
router.post("/", requireAuth, SessionController.create);
router.get("/", requireAuth, requireAdmin, SessionController.listAll);
router.get("/:id", requireAuth, requireAdmin, SessionController.get);
// IDOR guard: only the owning operator (or an admin) may touch a specific session.
router.post("/:id/reopen", requireAuth, requireSessionOwner, SessionController.reopen);
router.patch("/:id/integrate", requireAuth, requireAdmin, SessionController.integrate);
router.patch("/:id/close", requireN8N, SessionController.close);
router.post("/:id/prompt", requireAuth, requireSessionOwner, SessionController.sendPrompt);
router.get("/:id/progress", requireAuth, requireSessionOwner, SessionController.progress);
// POST /:id/progress is written by n8n inline during a turn — stays on requireN8N.
router.post("/:id/progress", requireN8N, SessionController.writeProgress);
router.get("/:session_id/messages", requireAuth, requireSessionOwner, SessionController.getMessages);


export default router;
