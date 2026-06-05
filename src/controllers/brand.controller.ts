import { Response } from "express";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";

export class BrandController {
  // Get all brands
  static async list(req: AuthenticatedRequest, res: Response) {
    try {
      const brands = await prisma.brand.findMany({
        orderBy: { name: "asc" },
      });
      return res.status(200).json(brands);
    } catch (error) {
      console.error("List brands error:", error);
      return res.status(500).json({ message: "Failed to list brands" });
    }
  }

  // Create brand (admin only)
  static async create(req: AuthenticatedRequest, res: Response) {
    try {
      const { name, industry, status } = req.body;
      if (!name || !industry) {
        return res.status(400).json({ message: "Name and industry are required" });
      }

      const brand = await prisma.brand.create({
        data: {
          name,
          industry,
          status: status || "Active",
        },
      });
      return res.status(201).json(brand);
    } catch (error) {
      console.error("Create brand error:", error);
      return res.status(500).json({ message: "Failed to create brand" });
    }
  }

  // Update brand (admin only)
  static async update(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, industry, status } = req.body;

      const existing = await prisma.brand.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Brand not found" });
      }

      const brand = await prisma.brand.update({
        where: { id },
        data: {
          name: name !== undefined ? name : undefined,
          industry: industry !== undefined ? industry : undefined,
          status: status !== undefined ? status : undefined,
        },
      });
      return res.status(200).json(brand);
    } catch (error) {
      console.error("Update brand error:", error);
      return res.status(500).json({ message: "Failed to update brand" });
    }
  }

  // Delete brand (admin only)
  static async delete(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;

      const existing = await prisma.brand.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Brand not found" });
      }

      await prisma.brand.delete({ where: { id } });
      return res.status(200).json({ ok: true, message: "Brand deleted successfully" });
    } catch (error) {
      console.error("Delete brand error:", error);
      return res.status(500).json({ message: "Failed to delete brand" });
    }
  }
}
