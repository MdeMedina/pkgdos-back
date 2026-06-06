import { Router } from "express";
import { SessionController } from "../controllers/session.controller.js";
import { requireAuth, requireAdmin, requireN8N } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/my-sessions", requireAuth, SessionController.mySessions);
router.post("/", requireAuth, SessionController.create);
router.get("/", requireAuth, requireAdmin, SessionController.listAll);
router.get("/:id", requireAuth, requireAdmin, SessionController.get);
router.post("/:id/reopen", requireAuth, SessionController.reopen);
router.patch("/:id/integrate", requireAuth, requireAdmin, SessionController.integrate);
router.patch("/:id/close", requireN8N, SessionController.close);
router.post("/:id/prompt", requireAuth, SessionController.sendPrompt);
router.get("/:session_id/messages", requireAuth, SessionController.getMessages);


export default router;
