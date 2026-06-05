import { Router } from "express";
import { AuthController } from "../controllers/auth.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.post("/login", AuthController.login);
router.get("/me", requireAuth, AuthController.me);
router.post("/logout", requireAuth, AuthController.logout);

export default router;
