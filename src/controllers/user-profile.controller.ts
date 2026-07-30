import { Response } from "express";
import fs from "node:fs";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { ProfileError, UserProfileService } from "../services/user-profile.service.js";

/** DTO del perfil para el front: nunca devuelve el texto completo, sólo de qué archivo salió. */
const toDto = (p: {
  source_file_url: string;
  source_file_name: string;
  mime_type: string;
  size: number;
  extracted_text: string;
  status: string;
  updated_at: Date;
}) => ({
  source_file_url: p.source_file_url,
  source_file_name: p.source_file_name,
  mime_type: p.mime_type,
  size: p.size,
  status: p.status,
  /** Primeras líneas, para que el operador confirme que se leyó lo que quería. */
  excerpt: p.extracted_text.slice(0, 400),
  char_count: p.extracted_text.length,
  updated_at: p.updated_at,
});

export class UserProfileController {
  // GET /users/me/profile — el about me del operador de la sesión (null si no subió ninguno).
  static async getMine(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: "Not authenticated" });
      const profile = await UserProfileService.get(req.user.id);
      return res.status(200).json(profile ? toDto(profile) : null);
    } catch (error) {
      console.error("Get user profile error:", error);
      return res.status(500).json({ message: "Failed to read the profile" });
    }
  }

  /**
   * POST /users/me/profile — sube (o reemplaza) el about me.
   *
   * Dos destinos, a propósito: el texto plano queda en la tabla para inyectarse en cada turno
   * del agente, y el archivo se manda al flujo de ingesta de n8n para quedar en pgvector.
   */
  static async uploadMine(req: AuthenticatedRequest, res: Response) {
    const file = req.file;
    try {
      if (!req.user) {
        if (file) fs.unlinkSync(file.path);
        return res.status(401).json({ message: "Not authenticated" });
      }
      if (!file) {
        return res.status(400).json({ message: "No file was uploaded" });
      }

      const storedUrl = `/uploads/${file.filename}`;
      // Se extrae ANTES de vectorizar: si el archivo no tiene texto, no se ensucia pgvector
      // ni se borra el perfil anterior.
      const text = await UserProfileService.extract(storedUrl, file.originalname, file.mimetype);

      const title = `About me · ${req.user.full_name}`;
      let assetId: string | null = null;

      if (env.N8N_BASE_URL) {
        // APP_BASE_URL y no el host de la petición: estas dos URLs las consume n8n desde otro
        // contenedor, donde un "127.0.0.1:5001" apuntaría a sí mismo.
        const base = env.APP_BASE_URL.replace(/\/+$/, "");
        const r = await fetch(`${env.N8N_BASE_URL}/webhook/ingest-document`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
          body: JSON.stringify({
            brand_id: null,
            title,
            asset_type: "UserProfile",
            source_file_url: `${base}${storedUrl}`,
            callback_url: `${base}/api/knowledge/callback`,
            department_id: null,
            department_role_id: null,
            // El flujo crea la fila del asset y responde 202 antes de insertarla, así que es
            // él quien graba al dueño; el backend sólo se queda con el id que le devuelve.
            user_id: req.user.id,
          }),
        });
        if (!r.ok) {
          throw new ProfileError(`Ingest webhook returned ${r.status}`);
        }
        const data = (await r.json()) as { knowledge_asset_id?: string };
        assetId = data.knowledge_asset_id ?? null;
      } else {
        // Sin n8n (dev): el perfil se guarda igual y sirve para la inyección; sólo no se vectoriza.
        console.warn("[Profile] N8N_BASE_URL not set; storing profile without vectorization.");
        const local = await prisma.knowledgeAsset.create({
          data: {
            title,
            asset_type: "UserProfile",
            status: "Active",
            user_id: req.user.id,
            source_file_url: storedUrl,
            vectorization_status: "Pending",
          },
        });
        assetId = local.id;
      }

      const profile = await UserProfileService.replace({
        userId: req.user.id,
        storedUrl,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        text,
        assetId,
      });

      return res.status(201).json(toDto(profile));
    } catch (error: any) {
      // El archivo recién subido no sirve de nada si el perfil no se guardó.
      if (file) fs.promises.unlink(file.path).catch(() => undefined);
      const status = error instanceof ProfileError ? error.status : 500;
      if (status >= 500) console.error("Upload user profile error:", error);
      return res.status(status).json({ message: error?.message ?? "Failed to save the profile" });
    }
  }

  // DELETE /users/me/profile — el operador retira su about me (y con él, lo que el agente sabe).
  static async deleteMine(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: "Not authenticated" });
      const removed = await UserProfileService.remove(req.user.id);
      if (!removed) return res.status(404).json({ message: "There is no profile to delete" });
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("Delete user profile error:", error);
      return res.status(500).json({ message: "Failed to delete the profile" });
    }
  }

  /**
   * GET /users/:id/profile-injection — bloque de texto listo para el mensaje de sistema.
   * Lo consume n8n en cada turno; devuelve "" cuando el operador no tiene perfil.
   */
  static async injection(req: AuthenticatedRequest, res: Response) {
    try {
      const block = await UserProfileService.injectionBlock(req.params.id);
      return res.status(200).json({ user_id: req.params.id, block, has_profile: block !== "" });
    } catch (error) {
      console.error("Profile injection error:", error);
      // El turno del agente no se cae por esto: sin bloque, se comporta como hoy.
      return res.status(200).json({ user_id: req.params.id, block: "", has_profile: false });
    }
  }
}
