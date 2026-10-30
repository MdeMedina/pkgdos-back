import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import { SpotlightController } from "../controllers/spotlight.controller.js";
import { requireAuth, requireAdmin, requireN8N } from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

const uploadDir = env.UPLOADS_DIR;
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Galería de imágenes de una nominación → /uploads (mismo dir/serving que Drive).
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, uploadDir),
  filename: (_r, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});
// Límite por nominación. El formulario lo valida antes de subir; si aun así se excede,
// se responde 400 con un mensaje claro (antes caía al genérico "unexpected error").
const MAX_IMAGENES = 20;
const imageUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_IMAGENES },
  fileFilter: (_r, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error("Solo se permiten imágenes"), { status: 400 }));
  },
});
const subirImagenes = (req: any, res: any, next: any) =>
  imageUpload.array("images", MAX_IMAGENES)(req, res, (err: any) => {
    if (!err) return next();
    const message =
      err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Máximo ${MAX_IMAGENES} imágenes por nominación.`
      : err.code === "LIMIT_FILE_SIZE" ? "Cada imagen debe pesar menos de 10 MB."
      : err.message || "No se pudo subir la imagen.";
    return res.status(400).json({ message });
  });

const router = Router();

// ── Lectura / participación (cualquier usuario autenticado) ──
router.get("/areas", requireAuth, SpotlightController.listAreas);
router.get("/people", requireAuth, SpotlightController.listPeople);
router.get("/home", requireAuth, SpotlightController.home);
router.get("/winners", requireAuth, SpotlightController.winners);
router.get("/awards/:year", requireAuth, SpotlightController.getAwards);
router.post("/awards/:year/vote", requireAuth, SpotlightController.awardVote);
router.post("/awards/:year/submit", requireAuth, SpotlightController.submitAwardBallot);
router.post("/nominations", requireAuth, subirImagenes, SpotlightController.createNomination);
router.patch("/nominations/:id", requireAuth, subirImagenes, SpotlightController.updateNomination);
router.get("/nominations/:id", requireAuth, SpotlightController.getNomination);
router.get("/link-preview", requireAuth, SpotlightController.linkPreview);
router.get("/link-image", SpotlightController.linkImage);
router.post("/review", requireAuth, SpotlightController.review);
router.post("/cycles/:id/vote", requireAuth, SpotlightController.vote);
router.post("/cycles/:id/special-vote", requireAuth, SpotlightController.specialVote);

// ── Admin ──
router.post("/areas", requireAuth, requireAdmin, SpotlightController.createArea);
router.patch("/areas/:id", requireAuth, requireAdmin, SpotlightController.updateArea);
router.delete("/areas/:id", requireAuth, requireAdmin, SpotlightController.deleteArea);
router.delete("/nominations/:id", requireAuth, SpotlightController.deleteNomination);
router.post("/nominations/import", requireAuth, requireAdmin, SpotlightController.importHistorical);
router.post("/cycles", requireAuth, requireAdmin, SpotlightController.createCycle);
router.post("/cycles/:id/open-voting", requireAuth, requireAdmin, SpotlightController.openVoting);
router.post("/cycles/:id/close-voting", requireAuth, requireAdmin, SpotlightController.closeVoting);
router.post("/cycles/:id/runoff", requireAuth, requireAdmin, SpotlightController.runoff);
router.post("/awards/:year/open", requireAuth, requireAdmin, SpotlightController.openAwards);
router.post("/awards/:year/close", requireAuth, requireAdmin, SpotlightController.closeAwards);
// Empate: ronda de desempate acotada al área, o decisión de dirección como salida.
router.post("/awards/:year/areas/:areaId/runoff", requireAuth, requireAdmin, SpotlightController.runoffArea);
router.post("/awards/:year/areas/:areaId/decide", requireAuth, requireAdmin, SpotlightController.decideArea);
// Revelado por área, para destaparlos uno a uno en la junta.
router.post("/awards/:year/areas/:areaId/reveal", requireAuth, requireAdmin, SpotlightController.revealArea);

// ── Rueda de premios (participantes del proyecto ganador) ──
// El sorteo ocurre en el servidor; el front solo anima hasta el índice devuelto.
router.get("/roulette", requireAuth, SpotlightController.roulette);
router.post("/roulette/spin", requireAuth, SpotlightController.spin);
router.get("/cycles/:id/prizes", requireAuth, SpotlightController.cyclePrizes);

// ── Comentarios dentro de una nominación ──
router.get("/nominations/:id/comments", requireAuth, SpotlightController.listComments);
router.post("/nominations/:id/comments", requireAuth, SpotlightController.addComment);
router.delete("/comments/:id", requireAuth, SpotlightController.deleteComment);

// ── n8n (schedule diario) ──
router.post("/cycle/tick", requireN8N, SpotlightController.tick);

export default router;
