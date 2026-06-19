import { Response, Request } from "express";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";

export class DepartmentController {
  // List all departments with their respective roles
  static async list(req: AuthenticatedRequest, res: Response) {
    try {
      const depts = await prisma.department.findMany({
        include: {
          roles: {
            orderBy: { name: "asc" },
          },
        },
        orderBy: { name: "asc" },
      });
      return res.status(200).json(depts);
    } catch (error) {
      console.error("List departments error:", error);
      return res.status(500).json({ message: "Failed to list departments" });
    }
  }

  // Create a new department
  static async create(req: AuthenticatedRequest, res: Response) {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Department name is required" });
      }

      const existing = await prisma.department.findUnique({
        where: { name: name.trim() },
      });
      if (existing) {
        return res.status(400).json({ message: "Department already exists" });
      }

      const dept = await prisma.department.create({
        data: { name: name.trim() },
        include: { roles: true },
      });

      return res.status(201).json(dept);
    } catch (error) {
      console.error("Create department error:", error);
      return res.status(500).json({ message: "Failed to create department" });
    }
  }

  // Update a department name
  static async update(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Department name is required" });
      }

      const existing = await prisma.department.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Department not found" });
      }

      const updated = await prisma.department.update({
        where: { id },
        data: { name: name.trim() },
        include: { roles: true },
      });

      return res.status(200).json(updated);
    } catch (error) {
      console.error("Update department error:", error);
      return res.status(500).json({ message: "Failed to update department" });
    }
  }

  // Delete a department and cascade delete its roles
  static async delete(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await prisma.department.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Department not found" });
      }

      await prisma.department.delete({ where: { id } });
      return res.status(200).json({ ok: true, message: "Department deleted successfully" });
    } catch (error) {
      console.error("Delete department error:", error);
      return res.status(500).json({ message: "Failed to delete department" });
    }
  }

  // Create a role under a department
  static async createRole(req: AuthenticatedRequest, res: Response) {
    try {
      const { departmentId } = req.params;
      const { name } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Role name is required" });
      }

      const dept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!dept) {
        return res.status(404).json({ message: "Department not found" });
      }

      const existing = await prisma.departmentRole.findFirst({
        where: {
          department_id: departmentId,
          name: name.trim(),
        },
      });
      if (existing) {
        return res.status(400).json({ message: "Role name already exists in this department" });
      }

      const role = await prisma.departmentRole.create({
        data: {
          name: name.trim(),
          department_id: departmentId,
        },
      });

      return res.status(201).json(role);
    } catch (error) {
      console.error("Create department role error:", error);
      return res.status(500).json({ message: "Failed to create role" });
    }
  }

  // Update a role
  static async updateRole(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Role name is required" });
      }

      const existing = await prisma.departmentRole.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Role not found" });
      }

      const updated = await prisma.departmentRole.update({
        where: { id },
        data: { name: name.trim() },
      });

      return res.status(200).json(updated);
    } catch (error) {
      console.error("Update department role error:", error);
      return res.status(500).json({ message: "Failed to update role" });
    }
  }

  // Delete a role
  static async deleteRole(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await prisma.departmentRole.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Role not found" });
      }

      await prisma.departmentRole.delete({ where: { id } });
      return res.status(200).json({ ok: true, message: "Role deleted successfully" });
    } catch (error) {
      console.error("Delete department role error:", error);
      return res.status(500).json({ message: "Failed to delete role" });
    }
  }
}
