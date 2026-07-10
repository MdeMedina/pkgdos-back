import { Router } from "express";
import { CompanyController } from "../controllers/company.controller.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

// Weekly company-mood diagnostic (admin only; UI shows it to Dirección General).
router.get("/diagnostic", requireAuth, requireAdmin, CompanyController.getDiagnostic);

export default router;
