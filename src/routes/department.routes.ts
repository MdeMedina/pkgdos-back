import { Router } from "express";
import { DepartmentController } from "../controllers/department.controller.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";

const router = Router();

// Department CRUD (requires authentication, writes require admin)
router.get("/", requireAuth, DepartmentController.list);
router.post("/", requireAuth, requireAdmin, DepartmentController.create);
router.patch("/:id", requireAuth, requireAdmin, DepartmentController.update);
router.delete("/:id", requireAuth, requireAdmin, DepartmentController.delete);

// Role CRUD under departments
router.post("/:departmentId/roles", requireAuth, requireAdmin, DepartmentController.createRole);
router.patch("/:departmentId/roles/:id", requireAuth, requireAdmin, DepartmentController.updateRole);
router.delete("/:departmentId/roles/:id", requireAuth, requireAdmin, DepartmentController.deleteRole);

export default router;
