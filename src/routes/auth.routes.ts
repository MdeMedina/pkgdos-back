import { Router } from "express";
import { AuthController } from "../controllers/auth.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { loginRateLimit } from "../middlewares/rate-limit.middleware.js";

const router = Router();

// Rate limit + progressive IP lockout to blunt credential stuffing / brute force.
router.post("/login", loginRateLimit, AuthController.login);
router.get("/activate/:token", AuthController.activate);
router.post("/set-password", AuthController.setPassword);
router.get("/me", requireAuth, AuthController.me);
router.post("/change-password", requireAuth, AuthController.changePassword);
router.post("/logout", requireAuth, AuthController.logout);

export default router;
