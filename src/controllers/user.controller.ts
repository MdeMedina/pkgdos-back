import { Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { toUserResponseDto } from "../dtos/user.dto.js";

export class UserController {
  // Admin-only listing of all operators
  static async list(req: AuthenticatedRequest, res: Response) {
    try {
      const users = await prisma.user.findMany({
        include: {
          brands: true,
          department: true,
          department_role: true,
        },
        orderBy: { created_at: "desc" },
      });

      const dtos = users.map((u) => toUserResponseDto(u, req.user?.global_role));
      return res.status(200).json(dtos);
    } catch (error) {
      console.error("List users error:", error);
      return res.status(500).json({ message: "Failed to list operators" });
    }
  }

  // Admin-only operator registration
  static async create(req: AuthenticatedRequest, res: Response) {
    try {
      const { full_name, email, password, global_role, brand_ids, department_id, department_role_id } = req.body;
      if (!full_name || !email || !password || !global_role) {
        return res.status(400).json({ message: "Missing required operator fields" });
      }

      const existing = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });
      if (existing) {
        return res.status(400).json({ message: "Operator email already registered" });
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      const sessionTokenN8n = `n8n.token.${Math.random().toString(36).substring(2, 10)}`;

      // Use a transaction to link brands immediately
      const created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            full_name,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            global_role,
            session_token_n8n: sessionTokenN8n,
            friction_level: 0.0,
            calcification_level: 0.0,
            department_id: department_id || null,
            department_role_id: department_role_id || null,
          },
        });

        if (brand_ids && Array.isArray(brand_ids) && brand_ids.length > 0) {
          await tx.userBrand.createMany({
            data: brand_ids.map((bid: string) => ({
              user_id: user.id,
              brand_id: bid,
            })),
          });
        }

        return tx.user.findUnique({
          where: { id: user.id },
          include: {
            brands: true,
            department: true,
            department_role: true,
          },
        });
      });

      return res.status(201).json(toUserResponseDto(created, req.user?.global_role));
    } catch (error) {
      console.error("Create user error:", error);
      return res.status(500).json({ message: "Failed to register operator" });
    }
  }

  // Admin-only updates
  static async update(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { full_name, email, global_role, brand_ids, department_id, department_role_id } = req.body;

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id },
          data: {
            full_name: full_name !== undefined ? full_name : undefined,
            email: email !== undefined ? email.toLowerCase() : undefined,
            global_role: global_role !== undefined ? global_role : undefined,
            department_id: department_id !== undefined ? (department_id || null) : undefined,
            department_role_id: department_role_id !== undefined ? (department_role_id || null) : undefined,
          },
        });

        if (brand_ids && Array.isArray(brand_ids)) {
          // Clear current brands and re-insert
          await tx.userBrand.deleteMany({ where: { user_id: id } });
          await tx.userBrand.createMany({
            data: brand_ids.map((bid: string) => ({
              user_id: id,
              brand_id: bid,
            })),
          });
        }

        return tx.user.findUnique({
          where: { id },
          include: {
            brands: true,
            department: true,
            department_role: true,
          },
        });
      });

      return res.status(200).json(toUserResponseDto(updated, req.user?.global_role));
    } catch (error) {
      console.error("Update user error:", error);
      return res.status(500).json({ message: "Failed to update operator" });
    }
  }

  // Admin-only deletion
  static async delete(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      await prisma.user.delete({ where: { id } });
      return res.status(200).json({ ok: true, message: "Operator deleted successfully" });
    } catch (error) {
      console.error("Delete user error:", error);
      return res.status(500).json({ message: "Failed to delete operator" });
    }
  }

  // Admin-only get operator diagnostic
  static async getDiagnostic(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      const sessions = await prisma.session.findMany({
        where: { user_id: id },
      });

      const max_friction = sessions.reduce((max, s) => Math.max(max, s.friction_level), 0);
      const encauzamiento_count = sessions.reduce((sum, s) => sum + s.encauzamiento_count, 0);
      const coupling_node_count = sessions.filter((s) => s.coupling_node_triggered).length;

      // Extract all glitches from sessions
      const glitches: any[] = [];
      sessions.forEach((s) => {
        if (s.glitches && Array.isArray(s.glitches)) {
          glitches.push(...s.glitches);
        }
      });

      const glitch_count = glitches.length;
      const score =
        glitch_count === 0
          ? 6.0
          : Math.round(
              (glitches.reduce((sum, g) => sum + (g.score || 0), 0) / glitch_count) * 10
            ) / 10;

      // Narrative logic
      let text = "Operación estable. Fricción dentro de rango, sin glitches críticos. Sin acción requerida.";
      if (encauzamiento_count >= 3 && score >= 5) {
        text = "Operador en encauzamiento sostenido. Capacidad demostrada de cortar el bucle defensivo y nombrar la variable. Apto para extracción de Oro Estructural.";
      } else if (max_friction >= 7 && score < 5) {
        text = "Alta fricción con baja resolución. El operador resiste el corte; predominan glitches sin reformulación. Intervenir antes de calcificar.";
      } else if (coupling_node_count > 0) {
        text = "Nodo de acoplamiento activo. La conversación tocó estructura. Monitorear si el próximo intervalo produce encauzamiento.";
      }

      return res.status(200).json({
        text,
        score,
        max_friction,
        encauzamiento_count,
        glitch_count,
        coupling_node_count,
        glitches,
      });
    } catch (error) {
      console.error("Get operator diagnostic error:", error);
      return res.status(500).json({ message: "Failed to fetch operational diagnostics" });
    }
  }
}
