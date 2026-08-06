import { Request, Response } from "express";
import { prisma } from "../config/database.js";
import { dropboxEnabled } from "../config/env.js";
import { DropboxError, getTemporaryLink, verifyWebhookSignature } from "../services/dropbox.service.js";
import { syncDropbox } from "../services/dropbox-sync.service.js";

/**
 * Puente HTTP con Dropbox:
 *  - GET  /webhook  → verificación de Dropbox (responde el challenge).
 *  - POST /webhook  → notificación de cambios (firma HMAC) → dispara sync en 2º plano.
 *  - GET  /raw/:id  → "enlace invisible": 302 a un enlace temporal fresco de Dropbox.
 *  - POST /sync     → disparo manual (bootstrap / reconciliación), protegido por token n8n.
 *  - GET  /status   → estado de la sincronización para la UI.
 */
export class DropboxController {
  // GET /api/drive/dropbox/webhook?challenge=xxxx
  // Dropbox verifica el endpoint pidiendo que le devolvamos el challenge tal cual.
  static verify(req: Request, res: Response) {
    const challenge = (req.query.challenge as string) ?? "";
    res.set("Content-Type", "text/plain");
    res.set("X-Content-Type-Options", "nosniff");
    return res.status(200).send(challenge);
  }

  // POST /api/drive/dropbox/webhook
  // Cloudflare corta a ~100s: respondemos 200 de inmediato y sincronizamos en 2º plano.
  static notify(req: Request & { rawBody?: Buffer }, res: Response) {
    const signature = req.header("X-Dropbox-Signature");
    if (!verifyWebhookSignature(req.rawBody, signature)) {
      console.warn("[Dropbox] webhook con firma inválida — descartado.");
      return res.status(403).json({ message: "invalid signature" });
    }
    // ACK inmediato; el trabajo real corre después (el servicio serializa/coalesce corridas).
    res.status(200).end();
    setImmediate(() => {
      syncDropbox().catch((e) => console.error("[Dropbox] sync tras webhook falló:", e?.message ?? e));
    });
  }

  // GET /api/drive/dropbox/raw/:id  (público, como /uploads)
  // Genera un enlace temporal fresco y redirige. Así el "enlace" del sistema nunca expira
  // para el usuario, aunque el de Dropbox dure ~4h.
  static async raw(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const file = await prisma.driveFile.findUnique({ where: { id } });
      if (!file || file.source !== "DROPBOX" || !file.dropbox_id) {
        return res.status(404).json({ message: "Archivo de Dropbox no encontrado" });
      }
      const link = await getTemporaryLink(file.dropbox_id);
      return res.redirect(302, link);
    } catch (error: any) {
      if (error instanceof DropboxError) {
        // "Puente" caído: mensaje amigable, no un crash.
        return res.status(error.status || 502).json({
          message: "No se pudo abrir el archivo desde Dropbox en este momento. Inténtalo de nuevo en unos minutos.",
        });
      }
      console.error("[Dropbox] raw redirect error:", error);
      return res.status(500).json({ message: "Error al resolver el archivo de Dropbox" });
    }
  }

  // POST /api/drive/dropbox/sync  (requireN8N) — bootstrap / reconciliación manual.
  static async sync(_req: Request, res: Response) {
    if (!dropboxEnabled()) {
      return res.status(503).json({ message: "Integración de Dropbox no configurada (faltan credenciales)." });
    }
    const result = await syncDropbox();
    return res.status(result.ok ? 200 : 502).json(result);
  }

  // GET /api/drive/dropbox/status  (requireAuth) — para la UI (banner de estado / errores).
  static async status(_req: Request, res: Response) {
    const state = await prisma.dropboxSyncState.findUnique({ where: { id: "singleton" } });
    const [folders, files] = await Promise.all([
      prisma.driveFolder.count({ where: { source: "DROPBOX" } }),
      prisma.driveFile.count({ where: { source: "DROPBOX" } }),
    ]);
    return res.status(200).json({
      enabled: dropboxEnabled(),
      root_path: state?.root_path ?? null,
      bootstrapped: Boolean(state?.cursor),
      last_synced_at: state?.last_synced_at ?? null,
      last_error: state?.last_error ?? null,
      mirrored_folders: folders,
      mirrored_files: files,
    });
  }
}
