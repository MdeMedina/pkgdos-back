import { Router } from "express";
import { UserController } from "../controllers/user.controller.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/", requireAuth, requireAdmin, UserController.list);
router.post("/", requireAuth, requireAdmin, UserController.create);
router.patch("/:id", requireAuth, requireAdmin, UserController.update);
router.delete("/:id", requireAuth, requireAdmin, UserController.delete);
router.get("/:id/diagnostic", requireAuth, requireAdmin, UserController.getDiagnostic);

export default router;
