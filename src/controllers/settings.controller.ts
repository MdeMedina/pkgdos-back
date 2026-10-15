import { Response } from "express";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";

// app_settings es un singleton (id="singleton"). lab_sections = lista de claves de
// sección (los `to` del nav del frontend, p.ej. "/spotlight") marcadas como
// "página de laboratorio": solo las ven usuarios con can_view_labs (o el owner).
export class SettingsController {
  // GET /api/settings/lab-sections — cualquier usuario autenticado (el shell lo usa
  // para filtrar su propio nav).
  static async getLabSections(_req: AuthenticatedRequest, res: Response) {
    try {
      const row = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
      const lab_sections = Array.isArray(row?.lab_sections) ? (row!.lab_sections as string[]) : [];
      return res.status(200).json({ lab_sections });
    } catch (error) {
      console.error("Get lab-sections error:", error);
      return res.status(500).json({ message: "Failed to read lab sections" });
    }
  }

  // PUT /api/settings/lab-sections — SOLO el dueño del laboratorio (is_lab_owner).
  static async setLabSections(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(req.user as any)?.is_lab_owner) {
        return res.status(403).json({ message: "Only the lab owner can change lab sections" });
      }
      const body = req.body?.lab_sections;
      if (!Array.isArray(body) || !body.every((s: unknown) => typeof s === "string")) {
        return res.status(400).json({ message: "lab_sections must be an array of strings" });
      }
      const lab_sections = Array.from(new Set(body.map((s: string) => String(s))));
      const row = await prisma.appSettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", lab_sections },
        update: { lab_sections },
      });
      return res.status(200).json({ lab_sections: row.lab_sections });
    } catch (error) {
      console.error("Set lab-sections error:", error);
      return res.status(500).json({ message: "Failed to update lab sections" });
    }
  }
}
