import { Router } from "express";
import { BrandController } from "../controllers/brand.controller.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/", requireAuth, BrandController.list);
router.post("/", requireAuth, requireAdmin, BrandController.create);
router.patch("/:id", requireAuth, requireAdmin, BrandController.update);
router.delete("/:id", requireAuth, requireAdmin, BrandController.delete);

export default router;
