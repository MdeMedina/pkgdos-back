import { Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { createNotifications, deleteNotificationsByRef, allUserIds, fireSpotlightWebhook } from "../services/notify.service.js";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const monthLabel = (y: number, m: number) => `${MESES[m - 1]} ${y}`;

// Ventana de votación (automática, la dispara el tick de n8n; CDMX = UTC-6, sin DST):
//  · ABRE el ÚLTIMO VIERNES del mes a las 08:00 CDMX (= cierre de nominaciones).
//  · CIERRA el sábado siguiente a las 00:00 CDMX (medianoche) y se anuncia ganador.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
// Día del mes del último viernes.
function lastFridayDay(year: number, month: number): number {
  const dim = daysInMonth(year, month);
  const lastDow = new Date(Date.UTC(year, month - 1, dim)).getUTCDay(); // 0 dom .. 6 sáb
  const diff = (lastDow - 5 + 7) % 7; // días hacia atrás hasta viernes (5)
  return dim - diff;
}
function cycleDates(year: number, month: number): { nominations_close_at: Date; voting_close_at: Date } {
  const lf = lastFridayDay(year, month);
  return {
    // Viernes 08:00 CDMX = 14:00 UTC (abre votación / cierran nominaciones)
    nominations_close_at: new Date(Date.UTC(year, month - 1, lf, 14, 0, 0)),
    // Sábado 00:00 CDMX = 06:00 UTC del día siguiente (+1 maneja el cambio de mes)
    voting_close_at: new Date(Date.UTC(year, month - 1, lf + 1, 6, 0, 0)),
  };
}

const uid = (req: AuthenticatedRequest) => (req.user as any)?.id as string;

async function isDirector(userId: string): Promise<boolean> {
  if (!userId) return false;
  const a = await prisma.spotlightArea.findFirst({
    where: { director_user_id: userId },
    select: { name: true },
  });
  return !!a;
}

// Garantiza un ciclo 'nominating' (crea el del mes actual si no hay ninguno).
async function ensureNominatingCycle() {
  const existing = await prisma.spotlightCycle.findFirst({
    where: { status: "nominating" },
    orderBy: { created_at: "desc" },
  });
  if (existing) return existing;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const dates = cycleDates(year, month);
  return prisma.spotlightCycle.upsert({
    where: { year_month: { year, month } },
    create: {
      year, month, label: monthLabel(year, month), status: "nominating",
      nominations_close_at: dates.nominations_close_at, voting_close_at: dates.voting_close_at,
    },
    update: {},
  });
}

// Serializa nominaciones: resuelve nombres de participantes/creador + oculta conteos si no `reveal`.
async function serialize(noms: any[], reveal: boolean) {
  const userIds = new Set<string>();
  for (const n of noms) {
    if (n.created_by_user_id) userIds.add(n.created_by_user_id);
    for (const p of n.participants ?? []) userIds.add(p.user_id);
  }
  const users = userIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, full_name: true, photo_url: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.full_name]));
  const photoOf = new Map(users.map((u) => [u.id, (u as any).photo_url ?? null]));
  const areaIds = [...new Set(noms.map((n) => n.area_id).filter(Boolean))] as string[];
  const areasList = areaIds.length
    ? await prisma.spotlightArea.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } })
    : [];
  const areaNameOf = new Map(areasList.map((a) => [a.id, a.name]));
  return noms.map((n) => ({
    id: n.id,
    cycle_id: n.cycle_id,
    area_id: n.area_id,
    area_name: n.area_id ? areaNameOf.get(n.area_id) ?? null : null,
    title: n.title,
    description: n.description,
    youtube_url: n.youtube_url,
    external_links: n.external_links ?? [],
    created_by: n.created_by_user_id ? { id: n.created_by_user_id, full_name: nameOf.get(n.created_by_user_id) ?? "—", photo_url: photoOf.get(n.created_by_user_id) ?? null } : null,
    participants: (n.participants ?? []).map((p: any) => ({ id: p.user_id, full_name: nameOf.get(p.user_id) ?? "—", photo_url: photoOf.get(p.user_id) ?? null })),
    lead_user_id: n.lead_user_id ?? null,
    images: (n.images ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order).map((i: any) => ({ id: i.id, url: i.url })),
    is_historical: n.is_historical,
    archived: n.archived,
    is_month_winner: n.is_month_winner,
    is_special_mention: n.is_special_mention,
    // Conteos SOLO cuando el ciclo cerró (anonimato del proceso en curso).
    vote_count: reveal ? n.vote_count : null,
    director_vote_count: reveal ? n.director_vote_count : null,
  }));
}

const cycleDto = (c: any) => c && ({
  id: c.id, year: c.year, month: c.month, label: c.label, status: c.status,
  nominations_close_at: c.nominations_close_at, voting_close_at: c.voting_close_at,
  winner_nomination_id: c.winner_nomination_id, special_mention_nomination_id: c.special_mention_nomination_id,
  is_tie: c.is_tie,
  // Ronda de desempate: qué nominaciones siguen en juego. El registro con votos de
  // cada ronda solo se expone al cerrar (los conteos son secretos mientras se vota).
  runoff_nomination_ids: c.runoff_nomination_ids ?? [],
  tie_history: c.status === "closed" ? (c.tie_history ?? []) : [],
});

// ── Link preview (Open Graph) + proxy de imagen ──────────────────────────────
function isBlockedHost(host: string): boolean {
  const h = (host || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}
function hostOf(u: string): string { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }
function htmlDecode(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&nbsp;/g, " ")
    .trim();
}
function ogPick(html: string, prop: string): string | null {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re1) || html.match(re2);
  return m ? htmlDecode(m[1]) : null;
}
async function fetchHtmlCapped(url: string, maxBytes: number, signal: AbortSignal) {
  const r = await fetch(url, {
    signal, redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PKGDOSBot/1.0; +https://os.pkgdgroup.com)", "Accept": "text/html,application/xhtml+xml,*/*" },
  });
  const contentType = r.headers.get("content-type") || "";
  const reader = r.body?.getReader();
  const decoder = new TextDecoder();
  let text = ""; let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      received += value.length;
      text += decoder.decode(value, { stream: true });
      if (received >= maxBytes) { try { await reader.cancel(); } catch { /* noop */ } break; }
    }
  }
  return { text, finalUrl: r.url, contentType };
}

export class SpotlightController {
  // ---------------- Áreas ----------------
  static async listAreas(_req: AuthenticatedRequest, res: Response) {
    try {
      const areas = await prisma.spotlightArea.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
      const dirIds = areas.map((a) => a.director_user_id).filter(Boolean) as string[];
      const dirs = dirIds.length
        ? await prisma.user.findMany({ where: { id: { in: dirIds } }, select: { id: true, full_name: true } })
        : [];
      const nameOf = new Map(dirs.map((u) => [u.id, u.full_name]));
      return res.json(areas.map((a) => ({
        id: a.id, name: a.name, sort_order: a.sort_order,
        director_user_id: a.director_user_id,
        director_name: a.director_user_id ? nameOf.get(a.director_user_id) ?? null : null,
      })));
    } catch (e) { console.error("listAreas", e); return res.status(500).json({ message: "Failed to list areas" }); }
  }

  static async createArea(req: AuthenticatedRequest, res: Response) {
    try {
      const { name, director_user_id, sort_order } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ message: "name required" });
      const a = await prisma.spotlightArea.create({
        data: { name: String(name).trim(), director_user_id: director_user_id || null, sort_order: Number(sort_order) || 0 },
      });
      return res.status(201).json(a);
    } catch (e) { console.error("createArea", e); return res.status(500).json({ message: "Failed to create area" }); }
  }

  static async updateArea(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { name, director_user_id, sort_order } = req.body;
      const a = await prisma.spotlightArea.update({
        where: { id },
        data: {
          name: name !== undefined ? String(name).trim() : undefined,
          director_user_id: director_user_id !== undefined ? (director_user_id || null) : undefined,
          sort_order: sort_order !== undefined ? Number(sort_order) : undefined,
        },
      });
      // El área y su departamento comparten nombre. Renombrar de cualquiera de
      // los dos lados mueve al otro; si no, las listas se separan otra vez.
      if (a.department_id && name !== undefined) {
        await prisma.department.updateMany({ where: { id: a.department_id }, data: { name: a.name } });
      }
      return res.json(a);
    } catch (e) { console.error("updateArea", e); return res.status(500).json({ message: "Failed to update area" }); }
  }

  static async deleteArea(req: AuthenticatedRequest, res: Response) {
    try {
      const id = req.params.id;
      // Sin esta guarda, borrar un área dejaba sus nominaciones sin categoría
      // (FK SetNull) y borraba en cascada las boletas de Awards de esa área.
      const usos = await prisma.spotlightNomination.count({ where: { area_id: id } });
      if (usos > 0) {
        return res.status(409).json({ message: `El área tiene ${usos} nominación(es): renómbrala o reasígnalas antes de borrarla.` });
      }
      const area = await prisma.spotlightArea.findUnique({ where: { id }, select: { department_id: true } });
      if (area?.department_id) {
        return res.status(409).json({ message: "Esta área es el espejo de un departamento. Borra el departamento si quieres quitarla." });
      }
      await prisma.spotlightArea.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) { console.error("deleteArea", e); return res.status(500).json({ message: "Failed to delete area" }); }
  }

  // Lista de usuarios (id + nombre) para el selector de participantes / director.
  // Cualquier usuario autenticado (a diferencia de /api/users que es admin-only).
  static async listPeople(_req: AuthenticatedRequest, res: Response) {
    try {
      const users = await prisma.user.findMany({
        orderBy: { full_name: "asc" },
        select: { id: true, full_name: true, email: true, photo_url: true },
      });
      return res.json(users);
    } catch (e) { console.error("listPeople", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- Home (feed del ciclo activo + mi estado) ----------------
  static async home(req: AuthenticatedRequest, res: Response) {
    try {
      const me = uid(req);
      const nominating = await prisma.spotlightCycle.findFirst({ where: { status: "nominating" }, orderBy: { created_at: "desc" } });
      const voting = await prisma.spotlightCycle.findFirst({ where: { status: "voting" }, orderBy: { created_at: "desc" } });
      // Ciclo activo a mostrar: votación si existe, si no el de nominación.
      const active = voting ?? nominating ?? (await ensureNominatingCycle());
      const reveal = active.status === "closed";

      // Ronda de desempate: solo las empatadas están en juego (feed, gate y voto).
      const enDesempate = active.status === "voting" && (active.runoff_nomination_ids?.length ?? 0) > 0;
      const noms = await prisma.spotlightNomination.findMany({
        // `archived` deja fuera arrastres de proyectos que ya se votaron en otro
        // ciclo: la fila sigue existiendo, pero no compite ni cuenta para el gate.
        where: { cycle_id: active.id, archived: false, ...(enDesempate ? { id: { in: active.runoff_nomination_ids } } : {}) },
        include: { images: true, participants: true },
        orderBy: { created_at: "asc" },
      });
      const nominations = await serialize(noms, reveal);

      // Mi progreso de review + estado de voto en el ciclo activo.
      // Acotado a las nominaciones VIVAS: una revisión sobre una archivada no
      // debe contar para el gate (si no, desbloquearía el voto de gratis).
      const liveIds = noms.map((n) => n.id);
      const myReviews = liveIds.length
        ? await prisma.spotlightReview.findMany({
            where: { cycle_id: active.id, user_id: me, reviewed: true, nomination_id: { in: liveIds } },
            select: { nomination_id: true },
          })
        : [];
      const reviewedIds = myReviews.map((r) => r.nomination_id);
      const hasVoted = !!(await prisma.spotlightBallot.findFirst({ where: { cycle_id: active.id, user_id: me, kind: "popular" } }));
      const hasSpecial = !!(await prisma.spotlightBallot.findFirst({ where: { cycle_id: active.id, user_id: me, kind: "special" } }));
      const director = await isDirector(me);
      const totalCount = noms.length;
      const allReviewed = totalCount > 0 && reviewedIds.length >= totalCount;

      return res.json({
        active_cycle: cycleDto(active),
        nominating_cycle: cycleDto(nominating ?? active),
        voting_cycle: cycleDto(voting),
        nominations,
        me: {
          reviewed_ids: reviewedIds,
          total: totalCount,
          has_voted: hasVoted,
          has_special_voted: hasSpecial,
          is_director: director,
          can_vote: active.status === "voting" && allReviewed && !hasVoted,
          can_special_vote: active.status === "voting" && director && !hasSpecial,
        },
      });
    } catch (e) { console.error("home", e); return res.status(500).json({ message: "Failed to load spotlight" }); }
  }

  static async getNomination(req: AuthenticatedRequest, res: Response) {
    try {
      const n = await prisma.spotlightNomination.findUnique({
        where: { id: req.params.id },
        include: { images: true, participants: true, cycle: true },
      });
      if (!n) return res.status(404).json({ message: "Not found" });
      const reveal = n.cycle.status === "closed";
      const [dto] = await serialize([n], reveal);
      const myReview = await prisma.spotlightReview.findUnique({ where: { user_id_nomination_id: { user_id: uid(req), nomination_id: n.id } } });
      return res.json({ ...dto, cycle_status: n.cycle.status, my_review: myReview ? { reviewed: myReview.reviewed, video_percent: myReview.video_percent, clicked_links: myReview.clicked_links ?? [] } : { reviewed: false, video_percent: 0, clicked_links: [] } });
    } catch (e) { console.error("getNomination", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- Crear nominación (multipart) ----------------
  static async createNomination(req: AuthenticatedRequest, res: Response) {
    try {
      const { title, area_id, description, youtube_url } = req.body;
      if (!title || !String(title).trim()) return res.status(400).json({ message: "title required" });
      let participant_ids: string[] = [];
      let external_links: any[] = [];
      try { participant_ids = JSON.parse(req.body.participant_ids || "[]"); } catch { /* noop */ }
      try { external_links = JSON.parse(req.body.external_links || "[]"); } catch { /* noop */ }

      const cycle = await ensureNominatingCycle();
      if (cycle.status !== "nominating") return res.status(400).json({ message: "Nominations are closed for now" });

      const files = ((req.files as Express.Multer.File[]) || []);
      const created = await prisma.$transaction(async (tx) => {
        const nom = await tx.spotlightNomination.create({
          data: {
            cycle_id: cycle.id,
            area_id: area_id || null,
            title: String(title).trim(),
            description: description ? String(description) : null,
            youtube_url: youtube_url ? String(youtube_url).trim() : null,
            external_links,
            created_by_user_id: uid(req) ?? null,
          },
        });
        const parts = [...new Set(participant_ids)].filter(Boolean);
        if (parts.length) {
          await tx.spotlightNominationParticipant.createMany({
            data: parts.map((pid) => ({ nomination_id: nom.id, user_id: pid })),
            skipDuplicates: true,
          });
          // Jefe del proyecto = la PRIMERA persona nominada. La tabla de
          // participantes no guarda orden, así que se fija aquí, explícito.
          await tx.spotlightNomination.update({ where: { id: nom.id }, data: { lead_user_id: parts[0] } });
        }
        if (files.length) {
          await tx.spotlightNominationImage.createMany({
            data: files.map((f, i) => ({ nomination_id: nom.id, url: `/uploads/${f.filename}`, sort_order: i })),
          });
        }
        return nom;
      });

      // Notifica a los participantes (menos a quien nominó).
      const targets = [...new Set(participant_ids)].filter((id) => id && id !== uid(req));
      if (targets.length) {
        await createNotifications(targets, {
          type: "spotlight",
          title: "Te incluyeron en una nominación de Spotlight",
          body: `Proyecto: ${String(title).trim()}`,
          link: `/spotlight?n=${created.id}`,
        });
        fireSpotlightWebhook("nominated", { nomination_id: created.id, title: String(title).trim(), participant_ids: targets });
      }
      return res.status(201).json({ id: created.id });
    } catch (e) { console.error("createNomination", e); return res.status(500).json({ message: "Failed to create nomination" }); }
  }

  static async deleteNomination(req: AuthenticatedRequest, res: Response) {
    try {
      // Solo el admin o el autor de la nominación pueden borrarla.
      const own = await prisma.spotlightNomination.findUnique({ where: { id: req.params.id }, select: { created_by_user_id: true } });
      if (!own) return res.status(404).json({ message: "Not found" });
      if ((req.user as any)?.global_role !== "admin" && own.created_by_user_id !== uid(req)) {
        return res.status(403).json({ message: "Solo puedes eliminar tus propias nominaciones" });
      }
      // Borra archivos físicos de las imágenes también.
      const imgs = await prisma.spotlightNominationImage.findMany({ where: { nomination_id: req.params.id }, select: { url: true } });
      await prisma.spotlightNomination.delete({ where: { id: req.params.id } });
      // best-effort unlink
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { env } = await import("../config/env.js");
      for (const im of imgs) {
        try { const p = path.join(env.UPLOADS_DIR, path.basename(im.url)); if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* noop */ }
      }
      return res.json({ ok: true });
    } catch (e) { console.error("deleteNomination", e); return res.status(500).json({ message: "Failed to delete" }); }
  }

  // ---------------- Review (ver antes de votar) ----------------
  static async review(req: AuthenticatedRequest, res: Response) {
    try {
      const { nomination_id, video_percent, clicked_link } = req.body;
      const nom = await prisma.spotlightNomination.findUnique({ where: { id: nomination_id }, select: { id: true, cycle_id: true, youtube_url: true, external_links: true } });
      if (!nom) return res.status(404).json({ message: "Not found" });
      const me = uid(req);
      const existing = await prisma.spotlightReview.findUnique({ where: { user_id_nomination_id: { user_id: me, nomination_id: nom.id } } });
      const pct = Math.max(Number(existing?.video_percent) || 0, Math.max(0, Math.min(100, Number(video_percent) || 0)));
      // Unión persistente de índices de links revisados (clickeados).
      const prev: number[] = Array.isArray(existing?.clicked_links) ? (existing!.clicked_links as unknown[]).map(Number).filter((n) => Number.isInteger(n)) : [];
      const clickSet = new Set<number>(prev);
      if (clicked_link !== undefined && clicked_link !== null && Number.isInteger(Number(clicked_link))) clickSet.add(Number(clicked_link));
      const linksArr = Array.isArray(nom.external_links) ? (nom.external_links as any[]) : [];
      const linksCount = linksArr.filter((l) => l && l.url).length;
      const clickedInRange = [...clickSet].filter((i) => i >= 0 && i < linksCount);
      const videoOk = !nom.youtube_url || pct >= 75;
      const linksOk = clickedInRange.length >= linksCount;
      const reviewed = videoOk && linksOk;
      const clickedLinks = [...clickSet].sort((a, b) => a - b);
      const row = await prisma.spotlightReview.upsert({
        where: { user_id_nomination_id: { user_id: me, nomination_id: nom.id } },
        create: { cycle_id: nom.cycle_id, user_id: me, nomination_id: nom.id, video_percent: pct, clicked_links: clickedLinks, reviewed, reviewed_at: reviewed ? new Date() : null },
        update: { video_percent: pct, clicked_links: clickedLinks, reviewed, reviewed_at: reviewed ? new Date() : undefined },
      });
      return res.json({ reviewed: row.reviewed, video_percent: row.video_percent, clicked_links: row.clicked_links, required_links: linksCount, has_video: !!nom.youtube_url });
    } catch (e) { console.error("review", e); return res.status(500).json({ message: "Failed to record review" }); }
  }

  // ---------------- Voto popular (anónimo) ----------------
  static async vote(req: AuthenticatedRequest, res: Response) {
    try {
      const cycleId = req.params.id;
      const { nomination_id } = req.body;
      const me = uid(req);
      const cycle = await prisma.spotlightCycle.findUnique({ where: { id: cycleId } });
      if (!cycle || cycle.status !== "voting") return res.status(400).json({ message: "Voting is not open" });
      // Empate declarado o fecha vencida: la votación queda congelada hasta que
      // dirección abra la ronda de desempate (antes seguía abierta y un voto tardío
      // rompía el empate solo).
      if (cycle.is_tie) return res.status(400).json({ message: "La votación terminó en empate: espera la ronda de desempate" });
      if (cycle.voting_close_at && cycle.voting_close_at <= new Date()) return res.status(400).json({ message: "La votación ya cerró" });
      // Solo se puede votar por una nominación VIVA: una archivada ni siquiera
      // aparece en el feed.
      const nom = await prisma.spotlightNomination.findFirst({ where: { id: nomination_id, cycle_id: cycleId, archived: false }, select: { id: true } });
      if (!nom) return res.status(400).json({ message: "Invalid nomination" });
      const enJuego: string[] = cycle.runoff_nomination_ids ?? [];
      if (enJuego.length && !enJuego.includes(nomination_id)) {
        return res.status(400).json({ message: "En la ronda de desempate solo se vota entre los proyectos empatados" });
      }

      // Gate de revisión, acotado a las nominaciones VIVAS del ciclo.
      // Antes contaba TODAS, archivadas incluidas: los arrastres de ciclos
      // anteriores no se ven en el feed pero sí se exigían, así que el gate era
      // imposible de cumplir y nadie podía votar. `home` ya lo acotaba bien;
      // este endpoint no, y por eso la interfaz decía "puedes votar" y el
      // servidor lo negaba.
      const vivas = await prisma.spotlightNomination.findMany({
        where: { cycle_id: cycleId, archived: false, ...(enJuego.length ? { id: { in: enJuego } } : {}) }, select: { id: true },
      });
      const total = vivas.length;
      const reviewed = vivas.length
        ? await prisma.spotlightReview.count({
            where: { cycle_id: cycleId, user_id: me, reviewed: true, nomination_id: { in: vivas.map((v) => v.id) } },
          })
        : 0;
      if (reviewed < total) return res.status(403).json({ message: "Debes revisar todas las nominaciones antes de votar", reviewed, total });
      // uno por persona; anónimo (ballot sin la elección + incremento del conteo)
      try {
        await prisma.$transaction([
          prisma.spotlightBallot.create({ data: { cycle_id: cycleId, user_id: me, kind: "popular" } }),
          prisma.spotlightNomination.update({ where: { id: nomination_id }, data: { vote_count: { increment: 1 } } }),
        ]);
      } catch (err: any) {
        if (err?.code === "P2002") return res.status(409).json({ message: "Ya votaste este mes" });
        throw err;
      }
      return res.json({ ok: true });
    } catch (e) { console.error("vote", e); return res.status(500).json({ message: "Failed to vote" }); }
  }

  // ---------------- Mención especial (solo directivos) ----------------
  static async specialVote(req: AuthenticatedRequest, res: Response) {
    try {
      const cycleId = req.params.id;
      const { nomination_id } = req.body;
      const me = uid(req);
      if (!(await isDirector(me))) return res.status(403).json({ message: "Solo los directivos de área eligen la mención especial" });
      const cycle = await prisma.spotlightCycle.findUnique({ where: { id: cycleId } });
      if (!cycle || cycle.status !== "voting") return res.status(400).json({ message: "Voting is not open" });
      const nom = await prisma.spotlightNomination.findFirst({ where: { id: nomination_id, cycle_id: cycleId }, select: { id: true } });
      if (!nom) return res.status(400).json({ message: "Invalid nomination" });
      try {
        await prisma.$transaction([
          prisma.spotlightBallot.create({ data: { cycle_id: cycleId, user_id: me, kind: "special" } }),
          prisma.spotlightNomination.update({ where: { id: nomination_id }, data: { director_vote_count: { increment: 1 } } }),
        ]);
      } catch (err: any) {
        if (err?.code === "P2002") return res.status(409).json({ message: "Ya elegiste tu mención especial" });
        throw err;
      }
      return res.json({ ok: true });
    } catch (e) { console.error("specialVote", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- Ciclos (admin) ----------------
  static async createCycle(req: AuthenticatedRequest, res: Response) {
    try {
      const now = new Date();
      const year = Number(req.body.year) || now.getUTCFullYear();
      const month = Number(req.body.month) || now.getUTCMonth() + 1;
      const def = cycleDates(year, month);
      const closeN = req.body.nominations_close_at ? new Date(req.body.nominations_close_at) : def.nominations_close_at;
      const closeV = req.body.voting_close_at ? new Date(req.body.voting_close_at) : def.voting_close_at;
      const c = await prisma.spotlightCycle.upsert({
        where: { year_month: { year, month } },
        create: { year, month, label: monthLabel(year, month), status: "nominating", nominations_close_at: closeN, voting_close_at: closeV },
        update: { nominations_close_at: closeN, voting_close_at: closeV },
      });
      return res.status(201).json(cycleDto(c));
    } catch (e) { console.error("createCycle", e); return res.status(500).json({ message: "Failed to create cycle" }); }
  }

  // nominating -> voting (manual admin; el tick lo hace por fecha)
  static async openVoting(req: AuthenticatedRequest, res: Response) {
    try {
      const c = await prisma.spotlightCycle.update({ where: { id: req.params.id }, data: { status: "voting" } });
      await SpotlightController._ensureNextNominating(c.year, c.month);
      await SpotlightController._notifyVotingOpen(c);
      return res.json(cycleDto(c));
    } catch (e) { console.error("openVoting", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async closeVoting(req: AuthenticatedRequest, res: Response) {
    return SpotlightController._closeVoting(req.params.id, res);
  }

  // Ronda de desempate. Antes reiniciaba TODO (conteos y boletas de todas las
  // nominaciones) y se perdía el resultado de la primera ronda. Ahora:
  //  1. guarda en `tie_history` los votos de la ronda que terminó en empate;
  //  2. deja en juego SOLO a las empatadas (`runoff_nomination_ids`);
  //  3. reabre la votación: todos vuelven a votar, solo entre las empatadas.
  // La mención de dirección no se toca.
  static async runoff(req: AuthenticatedRequest, res: Response) {
    // Duración de la ronda: la fecha original ya venció; sin una nueva, el tick
    // horario la cerraría de inmediato.
    const HORAS_DESEMPATE = 24;
    try {
      const cycleId = req.params.id;
      const cycle = await prisma.spotlightCycle.findUnique({ where: { id: cycleId } });
      if (!cycle) return res.status(404).json({ message: "Ciclo no encontrado" });
      if (!cycle.is_tie) return res.status(400).json({ message: "Este ciclo no está empatado" });
      const previas: string[] = cycle.runoff_nomination_ids ?? [];
      const noms = await prisma.spotlightNomination.findMany({
        where: { cycle_id: cycleId, archived: false, ...(previas.length ? { id: { in: previas } } : {}) },
        select: { id: true, title: true, vote_count: true },
      });
      const max = Math.max(0, ...noms.map((n) => n.vote_count));
      const empatadas = noms.filter((n) => max > 0 && n.vote_count === max);
      if (empatadas.length < 2) return res.status(400).json({ message: "No hay empate que desempatar" });
      const historial = Array.isArray(cycle.tie_history) ? (cycle.tie_history as any[]) : [];
      const boletas = await prisma.spotlightBallot.count({ where: { cycle_id: cycleId, kind: "popular" } });
      const ronda = {
        ronda: historial.length + 1,
        cerrada_at: new Date().toISOString(),
        boletas,
        votos: noms.map((n) => ({ nomination_id: n.id, title: n.title, votos: n.vote_count })),
        empatadas: empatadas.map((n) => n.id),
      };
      await prisma.$transaction([
        prisma.spotlightBallot.deleteMany({ where: { cycle_id: cycleId, kind: "popular" } }),
        prisma.spotlightNomination.updateMany({ where: { cycle_id: cycleId }, data: { vote_count: 0 } }),
        prisma.spotlightCycle.update({
          where: { id: cycleId },
          data: { status: "voting", is_tie: false, winner_nomination_id: null, voting_close_at: new Date(Date.now() + HORAS_DESEMPATE * 3600 * 1000),
                  runoff_nomination_ids: empatadas.map((n) => n.id), tie_history: [...historial, ronda] as any },
        }),
      ]);
      return res.json({ ok: true, ronda: ronda.ronda, empatadas: empatadas.map((n) => ({ id: n.id, title: n.title })) });
    } catch (e) { console.error("runoff", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- Tick n8n (avanza fases por fecha) ----------------
  static async tick(_req: AuthenticatedRequest, res: Response) {
    try {
      const now = new Date();
      const actions: string[] = [];
      // nominating -> voting cuando pasó la fecha de cierre
      const toVote = await prisma.spotlightCycle.findMany({ where: { status: "nominating", nominations_close_at: { lte: now } } });
      for (const c of toVote) {
        await prisma.spotlightCycle.update({ where: { id: c.id }, data: { status: "voting" } });
        await SpotlightController._ensureNextNominating(c.year, c.month);
        await SpotlightController._notifyVotingOpen(c);
        actions.push(`cycle ${c.label} -> voting`);
      }
      // voting -> closed cuando pasó la fecha de votación (red de seguridad; normalmente lo cierra el admin)
      const toClose = await prisma.spotlightCycle.findMany({ where: { status: "voting", is_tie: false, voting_close_at: { lte: now } } });
      for (const c of toClose) {
        const r = await SpotlightController._computeAndClose(c.id);
        actions.push(`cycle ${c.label} -> ${r.tie ? "empate (espera desempate)" : "closed"}`);
      }
      return res.json({ ok: true, actions });
    } catch (e) { console.error("tick", e); return res.status(500).json({ message: "tick failed" }); }
  }

  // ---------------- Ganadores / historial ----------------
  static async winners(_req: AuthenticatedRequest, res: Response) {
    try {
      const cycles = await prisma.spotlightCycle.findMany({ where: { status: "closed" }, orderBy: [{ year: "desc" }, { month: "desc" }] });
      const winnerIds = cycles.flatMap((c) => [c.winner_nomination_id, c.special_mention_nomination_id]).filter(Boolean) as string[];
      const noms = winnerIds.length
        ? await prisma.spotlightNomination.findMany({ where: { id: { in: winnerIds } }, include: { images: true, participants: true } })
        : [];
      const dtos = await serialize(noms, true);
      const byId = new Map(dtos.map((d) => [d.id, d]));
      return res.json(cycles.map((c) => ({
        cycle: cycleDto(c),
        winner: c.winner_nomination_id ? byId.get(c.winner_nomination_id) ?? null : null,
        special_mention: c.special_mention_nomination_id ? byId.get(c.special_mention_nomination_id) ?? null : null,
      })));
    } catch (e) { console.error("winners", e); return res.status(500).json({ message: "Failed" }); }
  }

  // Carga histórica (admin): array de { year, month, area_id?, title, is_winner?, is_special?, participant_ids?, youtube_url?, external_links?, description? }
  static async importHistorical(req: AuthenticatedRequest, res: Response) {
    try {
      const items: any[] = Array.isArray(req.body.items) ? req.body.items : [];
      let created = 0;
      for (const it of items) {
        const year = Number(it.year), month = Number(it.month);
        if (!year || !month || !it.title) continue;
        const cycle = await prisma.spotlightCycle.upsert({
          where: { year_month: { year, month } },
          create: { year, month, label: monthLabel(year, month), status: "closed", nominations_close_at: cycleDates(year, month).nominations_close_at },
          update: {},
        });
        const nom = await prisma.spotlightNomination.create({
          data: {
            cycle_id: cycle.id, area_id: it.area_id || null, title: String(it.title),
            description: it.description || null, youtube_url: it.youtube_url || null,
            external_links: it.external_links || [], is_historical: true,
            is_month_winner: !!it.is_winner, is_special_mention: !!it.is_special,
          },
        });
        if (Array.isArray(it.participant_ids) && it.participant_ids.length) {
          await prisma.spotlightNominationParticipant.createMany({
            data: it.participant_ids.map((pid: string) => ({ nomination_id: nom.id, user_id: pid })), skipDuplicates: true,
          });
        }
        const patch: any = {};
        if (it.is_winner) patch.winner_nomination_id = nom.id;
        if (it.is_special) patch.special_mention_nomination_id = nom.id;
        if (Object.keys(patch).length) await prisma.spotlightCycle.update({ where: { id: cycle.id }, data: patch });
        created++;
      }
      return res.json({ ok: true, created });
    } catch (e) { console.error("importHistorical", e); return res.status(500).json({ message: "Failed to import" }); }
  }

  // ---------------- Awards anuales (un ganador por área) ----------------
  // ==========================================================================
  // Spotlight Awards — reglas del tablero
  // ==========================================================================
  // ANONIMATO (regla de negocio, no tocar): hay DOS tablas y NUNCA se cruzan.
  //   · spotlight_award_ballots  sabe QUIÉN votó y en qué área → impide el doble voto.
  //   · spotlight_award_choices  sabe QUÉ se votó, bajo un token derivado → permite
  //     cambiar el voto hasta el cierre.
  // La correspondencia persona→token no se guarda en ningún lado: se deriva aquí.
  // Cualquier consulta que una las dos destruye el anonimato del sistema.
  static _voterToken(userId: string, awardCycleId: string): string {
    return crypto
      .createHmac("sha256", env.SPOTLIGHT_VOTE_SECRET)
      .update(`${userId}:${awardCycleId}`)
      .digest("hex");
  }

  /** Título comparable, para excluir por PROYECTO y no por nominación. */
  static _normTitle(t: string | null | undefined): string {
    return String(t || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /**
   * Nominaciones elegibles y áreas del año, con las reglas acordadas:
   *  · fuera las archivadas;
   *  · fuera los ganadores del mes POR PROYECTO (mismo título normalizado), no
   *    solo la nominación que ganó: si no, un proyecto que ganó agosto se colaba
   *    por su nominación de abril;
   *  · las áreas sin nominaciones elegibles no se muestran;
   *  · un área con UNA sola nominación no se vota: gana por defecto.
   */
  static async _awardsBoard(year: number) {
    const cycles = await prisma.spotlightCycle.findMany({ where: { year }, select: { id: true } });
    const cycleIds = cycles.map((c) => c.id);
    if (!cycleIds.length) return { areas: [], noms: [] as any[] };

    const ganadoresDelMes = await prisma.spotlightNomination.findMany({
      where: { cycle_id: { in: cycleIds }, is_month_winner: true },
      select: { title: true },
    });
    const excluidos = new Set(ganadoresDelMes.map((n) => SpotlightController._normTitle(n.title)));

    const todas = await prisma.spotlightNomination.findMany({
      where: { cycle_id: { in: cycleIds }, is_month_winner: false, archived: false },
      include: { images: true, participants: true },
    });
    const noms = todas.filter((n) => !excluidos.has(SpotlightController._normTitle(n.title)));

    const areas = await prisma.spotlightArea.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
    const porArea = new Map<string, any[]>();
    for (const n of noms) {
      if (!n.area_id) continue;
      if (!porArea.has(n.area_id)) porArea.set(n.area_id, []);
      porArea.get(n.area_id)!.push(n);
    }
    const vivas = areas
      .filter((a) => (porArea.get(a.id)?.length ?? 0) > 0)
      .map((a) => ({ area: a, noms: porArea.get(a.id)!, unico: porArea.get(a.id)!.length === 1 }));
    return { areas: vivas, noms };
  }

  static async getAwards(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const me = uid(req);
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      const { areas } = await SpotlightController._awardsBoard(year);

      // Los conteos solo se destapan cuando el área ya fue revelada.
      const winners = award
        ? await prisma.spotlightAwardWinner.findMany({ where: { award_cycle_id: award.id } })
        : [];
      const wByArea = new Map(winners.map((w) => [w.area_id, w]));

      // Mi elección por área. Se lee SOLO por token; nunca se cruza con las boletas.
      const token = award ? SpotlightController._voterToken(me, award.id) : null;
      const mias = token
        ? await prisma.spotlightAwardChoice.findMany({
            where: { award_cycle_id: award!.id, voter_token: token },
            select: { area_id: true, nomination_id: true },
          })
        : [];
      const myChoice = new Map(mias.map((c) => [c.area_id, c.nomination_id]));
      const submitted = award
        ? await prisma.spotlightAwardBallot.findFirst({
            where: { award_cycle_id: award.id, user_id: me, submitted_at: { not: null } },
            select: { submitted_at: true },
          })
        : null;

      const dtoAreas = [];
      for (const { area, noms, unico } of areas) {
        const w = wByArea.get(area.id);
        const revelada = !!w?.revealed_at;
        const dtos = await serialize(noms, revelada);
        dtoAreas.push({
          id: area.id,
          name: area.name,
          // Un área con una sola nominación no se vota: gana por defecto y no
          // cuenta para el requisito de completar la boleta.
          single_nominee: unico,
          votable: !unico,
          my_choice: unico ? noms[0].id : (myChoice.get(area.id) ?? null),
          revealed: revelada,
          runoff_open: !!w?.runoff_open,
          decided_by: w?.decided_by ?? null,
          winner_nomination_id: revelada ? (w?.nomination_id ?? (unico ? noms[0].id : null)) : null,
          nominations: dtos,
        });
      }
      const votables = dtoAreas.filter((a) => a.votable);
      return res.json({
        year,
        award: award ? { id: award.id, status: award.status, voting_close_at: award.voting_close_at } : null,
        progress: { voted: votables.filter((a) => a.my_choice).length, total: votables.length },
        submitted_at: submitted?.submitted_at ?? null,
        areas: dtoAreas,
      });
    } catch (e) { console.error("getAwards", e); return res.status(500).json({ message: "Failed" }); }
  }

  /** Emite o CAMBIA el voto de un área. El voto cuenta desde que se emite. */
  static async awardVote(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const { area_id, nomination_id } = req.body;
      const me = uid(req);
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award) return res.status(400).json({ message: "Awards voting not open" });

      // Abierto mientras el ciclo vota, o si ESTA área está en ronda de desempate.
      const w = await prisma.spotlightAwardWinner.findUnique({
        where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
      });
      const abierto = award.status === "voting" || !!w?.runoff_open;
      if (!abierto) return res.status(400).json({ message: "Awards voting not open" });

      // La nominación tiene que estar en el tablero de esa área (aplica todas las
      // reglas: archivadas fuera, ganadores del mes fuera por proyecto).
      const { areas } = await SpotlightController._awardsBoard(year);
      const board = areas.find((a) => a.area.id === area_id);
      if (!board) return res.status(400).json({ message: "Área sin nominaciones elegibles" });
      if (board.unico) return res.status(400).json({ message: "Esta área tiene un solo nominado: gana por defecto" });
      if (!board.noms.some((n: any) => n.id === nomination_id)) {
        return res.status(400).json({ message: "Invalid nomination for area" });
      }

      const token = SpotlightController._voterToken(me, award.id);
      const previa = await prisma.spotlightAwardChoice.findUnique({
        where: { award_cycle_id_voter_token_area_id: { award_cycle_id: award.id, voter_token: token, area_id } },
      });
      if (previa?.nomination_id === nomination_id) return res.json({ ok: true, unchanged: true });

      // Cambiar un voto son tres operaciones: si se parten, los contadores mienten
      // para siempre. Van juntas o no van.
      await prisma.$transaction(async (tx) => {
        if (previa) {
          await tx.spotlightAwardChoice.update({
            where: { award_cycle_id_voter_token_area_id: { award_cycle_id: award.id, voter_token: token, area_id } },
            data: { nomination_id },
          });
          await tx.spotlightNomination.update({
            where: { id: previa.nomination_id }, data: { award_vote_count: { decrement: 1 } },
          });
        } else {
          await tx.spotlightAwardChoice.create({
            data: { award_cycle_id: award.id, voter_token: token, area_id, nomination_id },
          });
          // La boleta registra que votaste, nunca por quién.
          await tx.spotlightAwardBallot.upsert({
            where: { award_cycle_id_user_id_area_id: { award_cycle_id: award.id, user_id: me, area_id } },
            create: { award_cycle_id: award.id, user_id: me, area_id },
            update: {},
          });
        }
        await tx.spotlightNomination.update({
          where: { id: nomination_id }, data: { award_vote_count: { increment: 1 } },
        });
      });
      return res.json({ ok: true, changed: !!previa });
    } catch (e) { console.error("awardVote", e); return res.status(500).json({ message: "Failed" }); }
  }

  /** "Enviar mis votos": confirmación. El voto ya contaba desde que se emitió. */
  static async submitAwardBallot(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const me = uid(req);
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award || award.status !== "voting") return res.status(400).json({ message: "Awards voting not open" });
      const { areas } = await SpotlightController._awardsBoard(year);
      const votables = areas.filter((a) => !a.unico).map((a) => a.area.id);
      const token = SpotlightController._voterToken(me, award.id);
      const mias = await prisma.spotlightAwardChoice.findMany({
        where: { award_cycle_id: award.id, voter_token: token }, select: { area_id: true },
      });
      const hechas = new Set(mias.map((c) => c.area_id));
      const faltan = votables.filter((id) => !hechas.has(id));
      if (faltan.length) return res.status(400).json({ message: "Faltan áreas por votar", faltan });
      await prisma.spotlightAwardBallot.updateMany({
        where: { award_cycle_id: award.id, user_id: me }, data: { submitted_at: new Date() },
      });
      return res.json({ ok: true });
    } catch (e) { console.error("submitAwardBallot", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async openAwards(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const a = await prisma.spotlightAwardCycle.upsert({ where: { year }, create: { year, status: "voting" }, update: { status: "voting" } });
      await createNotifications(await allUserIds(), { type: "spotlight", title: `Votación de los Spotlight Awards ${year} abierta`, body: "Elige al mejor representante de cada área.", link: `/spotlight` });
      fireSpotlightWebhook("awards_open", { year });
      return res.json({ ok: true, id: a.id });
    } catch (e) { console.error("openAwards", e); return res.status(500).json({ message: "Failed" }); }
  }

  /**
   * Cierra la votación anual y fija ganadores por área.
   * Un EMPATE arriba no se resuelve solo: el área queda sin ganador, marcada
   * como empate, y espera una ronda de desempate o la decisión de dirección.
   */
  static async closeAwards(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award) return res.status(404).json({ message: "No award cycle" });
      const { areas } = await SpotlightController._awardsBoard(year);
      const empates: Array<{ area_id: string; area: string; nominations: string[] }> = [];

      for (const { area, noms, unico } of areas) {
        if (unico) {
          await prisma.spotlightAwardWinner.upsert({
            where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id: area.id } },
            create: { award_cycle_id: award.id, area_id: area.id, nomination_id: noms[0].id, decided_by: "unico" },
            update: { nomination_id: noms[0].id, decided_by: "unico" },
          });
          continue;
        }
        const max = Math.max(0, ...noms.map((n: any) => n.award_vote_count));
        const top = noms.filter((n: any) => n.award_vote_count === max && max > 0);
        if (top.length === 1) {
          await prisma.spotlightAwardWinner.upsert({
            where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id: area.id } },
            create: { award_cycle_id: award.id, area_id: area.id, nomination_id: top[0].id, decided_by: "votos" },
            update: { nomination_id: top[0].id, decided_by: "votos" },
          });
        } else if (top.length > 1) {
          await prisma.spotlightAwardWinner.upsert({
            where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id: area.id } },
            create: { award_cycle_id: award.id, area_id: area.id, nomination_id: null, decided_by: "empate" },
            update: { nomination_id: null, decided_by: "empate" },
          });
          empates.push({ area_id: area.id, area: area.name, nominations: top.map((n: any) => n.id) });
        }
      }
      await prisma.spotlightAwardCycle.update({ where: { id: award.id }, data: { status: "closed" } });
      return res.json({ ok: true, empates });
    } catch (e) { console.error("closeAwards", e); return res.status(500).json({ message: "Failed" }); }
  }

  /** Abre una ronda de desempate acotada a un área empatada. Borra los votos de
   *  ESA área (elecciones y boletas) para que la ronda parta limpia. */
  static async runoffArea(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const area_id = req.params.areaId;
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award) return res.status(404).json({ message: "No award cycle" });
      const w = await prisma.spotlightAwardWinner.findUnique({
        where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
      });
      if (w?.decided_by !== "empate") return res.status(400).json({ message: "Esta área no está empatada" });
      const { areas } = await SpotlightController._awardsBoard(year);
      const board = areas.find((a) => a.area.id === area_id);
      if (!board) return res.status(400).json({ message: "Área sin nominaciones elegibles" });
      await prisma.$transaction(async (tx) => {
        await tx.spotlightAwardChoice.deleteMany({ where: { award_cycle_id: award.id, area_id } });
        await tx.spotlightAwardBallot.deleteMany({ where: { award_cycle_id: award.id, area_id } });
        for (const n of board.noms) {
          await tx.spotlightNomination.update({ where: { id: n.id }, data: { award_vote_count: 0 } });
        }
        await tx.spotlightAwardWinner.update({
          where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
          data: { runoff_open: true, nomination_id: null, decided_by: "desempate" },
        });
      });
      return res.json({ ok: true });
    } catch (e) { console.error("runoffArea", e); return res.status(500).json({ message: "Failed" }); }
  }

  /** Salida de emergencia: el directivo del área desempata. Queda registrado
   *  como decisión de dirección, NO como si el conteo lo hubiera dicho. */
  static async decideArea(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const area_id = req.params.areaId;
      const { nomination_id } = req.body;
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award) return res.status(404).json({ message: "No award cycle" });
      const { areas } = await SpotlightController._awardsBoard(year);
      const board = areas.find((a) => a.area.id === area_id);
      if (!board || !board.noms.some((n: any) => n.id === nomination_id)) {
        return res.status(400).json({ message: "Invalid nomination for area" });
      }
      await prisma.spotlightAwardWinner.upsert({
        where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
        create: { award_cycle_id: award.id, area_id, nomination_id, decided_by: "direccion", runoff_open: false },
        update: { nomination_id, decided_by: "direccion", runoff_open: false },
      });
      return res.json({ ok: true });
    } catch (e) { console.error("decideArea", e); return res.status(500).json({ message: "Failed" }); }
  }

  /** Destapa el ganador de un área. Hasta entonces sus conteos van ocultos. */
  static async revealArea(req: AuthenticatedRequest, res: Response) {
    try {
      const year = Number(req.params.year);
      const area_id = req.params.areaId;
      const award = await prisma.spotlightAwardCycle.findUnique({ where: { year } });
      if (!award) return res.status(404).json({ message: "No award cycle" });
      const w = await prisma.spotlightAwardWinner.findUnique({
        where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
      });
      if (!w?.nomination_id) return res.status(400).json({ message: "Esta área todavía no tiene ganador" });
      await prisma.spotlightAwardWinner.update({
        where: { award_cycle_id_area_id: { award_cycle_id: award.id, area_id } },
        data: { revealed_at: new Date() },
      });
      return res.json({ ok: true });
    } catch (e) { console.error("revealArea", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- helpers privados ----------------
  // Editar una nominación (autor o admin). Solo mientras el ciclo esté en nominación (salvo admin).
  static async updateNomination(req: AuthenticatedRequest, res: Response) {
    try {
      const id = req.params.id;
      const nom = await prisma.spotlightNomination.findUnique({ where: { id }, include: { cycle: true, images: true } });
      if (!nom) return res.status(404).json({ message: "Not found" });
      const me = uid(req);
      // Solo el AUTOR puede editar su propia nominación (ni siquiera un admin edita ajenas).
      if (nom.created_by_user_id !== me) return res.status(403).json({ message: "Solo puedes editar tus propias nominaciones" });
      if (nom.cycle.status !== "nominating") return res.status(400).json({ message: "No se puede editar una vez abierta la votación" });

      const { title, area_id, description, youtube_url } = req.body;
      let participant_ids: string[] | undefined;
      let external_links: any[] | undefined;
      let remove_image_ids: string[] = [];
      try { if (req.body.participant_ids !== undefined) participant_ids = JSON.parse(req.body.participant_ids); } catch { /* noop */ }
      try { if (req.body.external_links !== undefined) external_links = JSON.parse(req.body.external_links); } catch { /* noop */ }
      try { remove_image_ids = JSON.parse(req.body.remove_image_ids || "[]"); } catch { /* noop */ }
      const files = ((req.files as Express.Multer.File[]) || []);

      await prisma.$transaction(async (tx) => {
        await tx.spotlightNomination.update({
          where: { id },
          data: {
            title: title !== undefined ? String(title).trim() : undefined,
            area_id: area_id !== undefined ? (area_id || null) : undefined,
            description: description !== undefined ? (description ? String(description) : null) : undefined,
            youtube_url: youtube_url !== undefined ? (youtube_url ? String(youtube_url).trim() : null) : undefined,
            external_links: external_links !== undefined ? external_links : undefined,
          },
        });
        if (participant_ids !== undefined) {
          await tx.spotlightNominationParticipant.deleteMany({ where: { nomination_id: id } });
          const parts = [...new Set(participant_ids)].filter(Boolean);
          if (parts.length) await tx.spotlightNominationParticipant.createMany({ data: parts.map((pid) => ({ nomination_id: id, user_id: pid })), skipDuplicates: true });
          // El jefe sigue siendo el primero de la lista que llega del formulario.
          // Pero NO en un ciclo ya cerrado: ahí decide quién gira la ruleta, y
          // un admin corrigiendo un dato no debe quitársela a nadie de rebote.
          if (nom.cycle.status !== "closed") {
            await tx.spotlightNomination.update({ where: { id }, data: { lead_user_id: parts[0] ?? null } });
          }
        }
        if (remove_image_ids.length) {
          await tx.spotlightNominationImage.deleteMany({ where: { id: { in: remove_image_ids }, nomination_id: id } });
        }
        if (files.length) {
          const maxOrder = nom.images.reduce((m, im) => Math.max(m, (im as any).sort_order ?? 0), -1);
          await tx.spotlightNominationImage.createMany({ data: files.map((f, i) => ({ nomination_id: id, url: `/uploads/${f.filename}`, sort_order: maxOrder + 1 + i })) });
        }
      });

      if (remove_image_ids.length) {
        const removed = nom.images.filter((im) => remove_image_ids.includes(im.id));
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { env } = await import("../config/env.js");
        for (const im of removed) { try { const p = path.join(env.UPLOADS_DIR, path.basename(im.url)); if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* noop */ } }
      }
      return res.json({ ok: true });
    } catch (e) { console.error("updateNomination", e); return res.status(500).json({ message: "Failed to update" }); }
  }

  // Preview Open Graph de un link externo (server-side, evita CORS).
  static async linkPreview(req: AuthenticatedRequest, res: Response) {
    const url = String(req.query.url || "");
    const fallback = { url, title: null, description: null, image: null, site: hostOf(url), domain: hostOf(url) };
    try {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ message: "Invalid url" });
      let host = "";
      try { host = new URL(url).hostname; } catch { return res.status(400).json({ message: "Invalid url" }); }
      if (isBlockedHost(host)) return res.json(fallback);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const { text, finalUrl, contentType } = await fetchHtmlCapped(url, 300_000, ctrl.signal);
        if (isBlockedHost(hostOf(finalUrl))) return res.json(fallback);
        if (!contentType.includes("text/html")) return res.json({ ...fallback, domain: hostOf(finalUrl) });
        const titleTag = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = ogPick(text, "og:title") || (titleTag ? htmlDecode(titleTag[1]) : null);
        const description = ogPick(text, "og:description") || ogPick(text, "twitter:description") || ogPick(text, "description");
        let image = ogPick(text, "og:image") || ogPick(text, "og:image:url") || ogPick(text, "og:image:secure_url") || ogPick(text, "twitter:image") || ogPick(text, "twitter:image:src");
        if (image && !/^https?:\/\//i.test(image)) { try { image = new URL(image, finalUrl).href; } catch { image = null; } }
        const site = ogPick(text, "og:site_name") || hostOf(finalUrl);
        const token = jwt.sign({ userId: uid(req) }, env.JWT_SECRET, { expiresIn: "6h" });
        const proxied = image ? `/api/spotlight/link-image?u=${encodeURIComponent(image)}&token=${encodeURIComponent(token)}` : null;
        return res.json({ url, title, description, image: proxied, site, domain: hostOf(finalUrl) });
      } finally { clearTimeout(t); }
    } catch { return res.json(fallback); }
  }

  // Proxy same-origin de la imagen del preview (evita CSP/hotlink). Token por query para <img>.
  static async linkImage(req: AuthenticatedRequest, res: Response) {
    try {
      const raw = String(req.query.u || "");
      const token = String(req.query.token || "");
      try { jwt.verify(token, env.JWT_SECRET); } catch { return res.status(401).end(); }
      if (!/^https?:\/\//i.test(raw)) return res.status(400).end();
      if (isBlockedHost(hostOf(raw))) return res.status(400).end();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(raw, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; PKGDOSBot/1.0)" } });
        if (isBlockedHost(hostOf(r.url))) return res.status(400).end();
        const ct = r.headers.get("content-type") || "";
        if (!ct.startsWith("image/")) return res.status(415).end();
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5_000_000) return res.status(413).end();
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.end(buf);
      } finally { clearTimeout(t); }
    } catch { return res.status(500).end(); }
  }

  static async _ensureNextNominating(year: number, month: number) {
    const ny = month === 12 ? year + 1 : year;
    const nm = month === 12 ? 1 : month + 1;
    const dates = cycleDates(ny, nm);
    await prisma.spotlightCycle.upsert({
      where: { year_month: { year: ny, month: nm } },
      create: { year: ny, month: nm, label: monthLabel(ny, nm), status: "nominating", nominations_close_at: dates.nominations_close_at, voting_close_at: dates.voting_close_at },
      update: {},
    });
  }

  static async _notifyVotingOpen(c: any) {
    await createNotifications(await allUserIds(), {
      type: "spotlight",
      title: `Votación de Spotlight abierta · ${c.label}`,
      body: "Revisa todas las nominaciones y emite tu voto.",
      link: "/spotlight",
    });
    fireSpotlightWebhook("voting_open", { cycle_id: c.id, label: c.label });
  }

  static async _closeVoting(cycleId: string, res: Response) {
    try {
      const result = await SpotlightController._computeAndClose(cycleId);
      if (result.tie) return res.status(200).json({ ok: true, tie: true, message: "Empate: usa runoff para desempatar", tied: result.tied });
      return res.json({ ok: true, winner_nomination_id: result.winnerId, special_mention_nomination_id: result.specialId });
    } catch (e) { console.error("closeVoting", e); return res.status(500).json({ message: "Failed to close voting" }); }
  }

  static async _computeAndClose(cycleId: string) {
    const noms = await prisma.spotlightNomination.findMany({ where: { cycle_id: cycleId, archived: false }, select: { id: true, vote_count: true, director_vote_count: true } });
    const cycle = await prisma.spotlightCycle.findUnique({ where: { id: cycleId } });
    // ganador popular: en ronda de desempate compiten solo las empatadas
    const enJuego: string[] = cycle?.runoff_nomination_ids ?? [];
    const candidatas = enJuego.length ? noms.filter((n) => enJuego.includes(n.id)) : noms;
    const maxVotes = Math.max(0, ...candidatas.map((n) => n.vote_count));
    const topVoted = candidatas.filter((n) => n.vote_count === maxVotes && maxVotes > 0);
    if (topVoted.length > 1) {
      await prisma.spotlightCycle.update({ where: { id: cycleId }, data: { is_tie: true } });
      return { tie: true, tied: topVoted.map((n) => n.id), winnerId: null, specialId: null };
    }
    const winnerId = topVoted[0]?.id ?? null;
    // mención especial (más votos de directivos)
    const maxDir = Math.max(0, ...noms.map((n) => n.director_vote_count));
    const specialId = maxDir > 0 ? (noms.find((n) => n.director_vote_count === maxDir)?.id ?? null) : null;
    await prisma.$transaction(async (tx) => {
      // La ruleta se habilita SOLO si hubo ganador. Los ciclos cerrados antes de
      // existir esta mecánica se quedan en false (decisión: aplica de aquí en adelante).
      await tx.spotlightCycle.update({ where: { id: cycleId }, data: { status: "closed", is_tie: false, winner_nomination_id: winnerId, special_mention_nomination_id: specialId, roulette_enabled: !!winnerId } });
      if (winnerId) await tx.spotlightNomination.update({ where: { id: winnerId }, data: { is_month_winner: true } });
      if (specialId) await tx.spotlightNomination.update({ where: { id: specialId }, data: { is_special_mention: true } });
    });
    await createNotifications(await allUserIds(), {
      type: "spotlight",
      title: `Ganador de Spotlight · ${cycle?.label ?? ""}`,
      body: "Ya puedes ver al ganador del mes y la mención especial.",
      link: "/spotlight",
    });
    // Aviso aparte para el equipo ganador: ellos sí tienen algo que hacer.
    if (winnerId) {
      const ganadores = await prisma.spotlightNominationParticipant.findMany({
        where: { nomination_id: winnerId }, select: { user_id: true },
      });
      const ids = ganadores.map((g) => g.user_id);
      // Con jefe registrado, SOLO él gira la ruleta: a los demás no se les dice
      // que tienen giros. Sin jefe (nominaciones anteriores), todos, como antes.
      const ganadora = await prisma.spotlightNomination.findUnique({ where: { id: winnerId }, select: { lead_user_id: true } });
      const jefe = ganadora?.lead_user_id ?? null;
      const conRuleta = jefe ? ids.filter((x) => x === jefe) : ids;
      const sinRuleta = jefe ? ids.filter((x) => x !== jefe) : [];
      if (conRuleta.length) {
        await createNotifications(conRuleta, {
          type: "spotlight",
          title: `Ganaron el Spotlight · ${cycle?.label ?? ""}`,
          body: "Abre tu ruleta de premios: tienes 3 giros.",
          link: "/spotlight",
        });
      }
      if (sinRuleta.length) {
        await createNotifications(sinRuleta, {
          type: "spotlight",
          title: `Ganaron el Spotlight · ${cycle?.label ?? ""}`,
          body: "Su proyecto ganó el mes. La ruleta de premios la gira el jefe del proyecto.",
          link: "/spotlight",
        });
      }
    }
    fireSpotlightWebhook("winner", { cycle_id: cycleId, label: cycle?.label, winner_nomination_id: winnerId, special_mention_nomination_id: specialId });
    return { tie: false, tied: [], winnerId, specialId };
  }

  // ---------------- Rueda de premios ----------------
  // El premio lo sortea el SERVIDOR. El navegador solo anima hasta el índice que
  // le devolvemos: si alguien abre la consola, no puede cambiar lo que se ganó.
  static readonly SPINS_POR_PERSONA = 3;

  /** Ciclo con ruleta viva para ESTE usuario: cerrado, con ganador y él como participante. */
  static async _rouletteContext(userId: string) {
    const cycle = await prisma.spotlightCycle.findFirst({
      where: { status: "closed", roulette_enabled: true, winner_nomination_id: { not: null } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
    if (!cycle?.winner_nomination_id) return null;
    const nomination = await prisma.spotlightNomination.findUnique({
      where: { id: cycle.winner_nomination_id }, select: { id: true, title: true, lead_user_id: true },
    });
    if (!nomination) return null;
    // REGLA (por orden de dirección): la ruleta la gira SOLO el jefe del proyecto,
    // que es la primera persona nominada. Las nominaciones anteriores a la regla
    // no tienen jefe registrado: ahí gira cualquier participante, como antes, para
    // no quitarle la ruleta a nadie a mitad de un ciclo ya cerrado.
    if (nomination.lead_user_id) {
      if (nomination.lead_user_id !== userId) return null;
    } else {
      const esParticipante = await prisma.spotlightNominationParticipant.findUnique({
        where: { nomination_id_user_id: { nomination_id: cycle.winner_nomination_id, user_id: userId } },
      });
      if (!esParticipante) return null;
    }
    return { cycle, nomination: { id: nomination.id, title: nomination.title } };
  }

  static async roulette(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const ctx = await SpotlightController._rouletteContext(userId);
      const prizes = await prisma.spotlightPrize.findMany({ where: { active: true }, orderBy: { sort_order: "asc" } });
      if (!ctx) return res.json({ eligible: false, spins_left: 0, prizes: prizes.map((p) => p.label), current_prize: null, discarded_prizes: [] });
      const mine = await prisma.spotlightPrizeSpin.findMany({
        where: { cycle_id: ctx.cycle.id, user_id: userId }, orderBy: { spin_index: "asc" },
      });
      // REGLA DE NEGOCIO: los giros NO se acumulan. El premio que te llevas es el
      // del ULTIMO giro; volver a girar significa renunciar al anterior. Los giros
      // previos se conservan en base solo como historial/auditoria.
      const vigente = mine.length ? mine[mine.length - 1] : null;
      return res.json({
        eligible: true,
        cycle: { id: ctx.cycle.id, label: ctx.cycle.label },
        nomination: ctx.nomination,
        spins_left: Math.max(0, SpotlightController.SPINS_POR_PERSONA - mine.length),
        prizes: prizes.map((p) => p.label),
        current_prize: vigente
          ? { spin_index: vigente.spin_index, prize_label: vigente.prize_label, created_at: vigente.created_at }
          : null,
        discarded_prizes: mine.slice(0, -1).map((s) => s.prize_label),
      });
    } catch (e) { console.error("roulette", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async spin(req: AuthenticatedRequest, res: Response) {
    try {
      const userId = req.user!.id;
      const ctx = await SpotlightController._rouletteContext(userId);
      if (!ctx) return res.status(403).json({ message: "No tienes una ruleta disponible" });
      const usados = await prisma.spotlightPrizeSpin.count({ where: { cycle_id: ctx.cycle.id, user_id: userId } });
      if (usados >= SpotlightController.SPINS_POR_PERSONA) {
        return res.status(409).json({ message: "Ya usaste tus 3 giros" });
      }
      const prizes = await prisma.spotlightPrize.findMany({ where: { active: true }, orderBy: { sort_order: "asc" } });
      if (!prizes.length) return res.status(409).json({ message: "No hay premios configurados" });

      // Sorteo del servidor. Premios ilimitados y repetibles (decisión del negocio).
      const idx = crypto.randomInt(0, prizes.length);
      const premio = prizes[idx];
      try {
        await prisma.spotlightPrizeSpin.create({
          data: {
            cycle_id: ctx.cycle.id, nomination_id: ctx.nomination!.id, user_id: userId,
            prize_id: premio.id, prize_label: premio.label, spin_index: usados + 1,
          },
        });
      } catch (err: any) {
        // Choque con el UNIQUE = dos giros simultáneos del mismo usuario. El tope
        // lo garantiza la base, no el conteo de arriba.
        if (err?.code === "P2002") return res.status(409).json({ message: "Giro duplicado, recarga la página" });
        throw err;
      }
      return res.json({
        prize_index: idx,
        prize_label: premio.label,
        spins_left: Math.max(0, SpotlightController.SPINS_POR_PERSONA - (usados + 1)),
      });
    } catch (e) { console.error("spin", e); return res.status(500).json({ message: "Failed to spin" }); }
  }

  /** Premios entregados de un ciclo (para mostrar quién ganó qué). */
  static async cyclePrizes(req: AuthenticatedRequest, res: Response) {
    try {
      const spins = await prisma.spotlightPrizeSpin.findMany({
        where: { cycle_id: req.params.id }, orderBy: [{ user_id: "asc" }, { spin_index: "asc" }],
      });
      if (!spins.length) return res.json([]);
      const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(spins.map((s) => s.user_id))] } },
        select: { id: true, full_name: true, photo_url: true },
      });
      const uOf = new Map(users.map((u) => [u.id, u]));
      // Los giros vienen ordenados por (user_id, spin_index asc), asi que el ultimo
      // que se escribe por persona es su premio vigente: girar de nuevo descarta el
      // anterior, no lo suma.
      const porUsuario = new Map<string, any>();
      for (const s of spins) {
        const u = uOf.get(s.user_id);
        porUsuario.set(s.user_id, {
          user: { id: s.user_id, full_name: u?.full_name ?? "—", photo_url: (u as any)?.photo_url ?? null },
          prizes: [s.prize_label],
          spins_used: s.spin_index,
        });
      }
      return res.json([...porUsuario.values()]);
    } catch (e) { console.error("cyclePrizes", e); return res.status(500).json({ message: "Failed" }); }
  }

  // ---------------- Comentarios en nominaciones ----------------
  static async listComments(req: AuthenticatedRequest, res: Response) {
    try {
      const rows = await prisma.spotlightComment.findMany({
        where: { nomination_id: req.params.id }, orderBy: { created_at: "asc" },
      });
      if (!rows.length) return res.json([]);
      const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.user_id))] } },
        select: { id: true, full_name: true, photo_url: true },
      });
      const uOf = new Map(users.map((u) => [u.id, u]));
      const me = req.user!;
      return res.json(rows.map((r) => ({
        id: r.id,
        body: r.body,
        created_at: r.created_at,
        author: {
          id: r.user_id,
          full_name: uOf.get(r.user_id)?.full_name ?? "—",
          photo_url: (uOf.get(r.user_id) as any)?.photo_url ?? null,
        },
        can_delete: r.user_id === me.id || me.global_role === "admin",
      })));
    } catch (e) { console.error("listComments", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async addComment(req: AuthenticatedRequest, res: Response) {
    try {
      const body = String(req.body?.body ?? "").trim();
      if (!body) return res.status(400).json({ message: "El comentario viene vacío" });
      if (body.length > 2000) return res.status(400).json({ message: "Máximo 2000 caracteres" });
      const nom = await prisma.spotlightNomination.findUnique({ where: { id: req.params.id }, select: { id: true, title: true } });
      if (!nom) return res.status(404).json({ message: "Nominación no encontrada" });
      const row = await prisma.spotlightComment.create({
        data: { nomination_id: nom.id, user_id: req.user!.id, body },
      });
      // Avisa a los participantes (menos a quien comentó).
      const parts = await prisma.spotlightNominationParticipant.findMany({
        where: { nomination_id: nom.id }, select: { user_id: true },
      });
      const targets = parts.map((p) => p.user_id).filter((id) => id !== req.user!.id);
      if (targets.length) {
        await createNotifications(targets, {
          type: "spotlight",
          title: "Nuevo comentario en tu nominación",
          body: `${req.user!.full_name}: ${body.slice(0, 80)}`,
          link: `/spotlight?n=${nom.id}`,
          ref_id: row.id,
        });
      }
      return res.status(201).json({ id: row.id });
    } catch (e) { console.error("addComment", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async deleteComment(req: AuthenticatedRequest, res: Response) {
    try {
      const row = await prisma.spotlightComment.findUnique({ where: { id: req.params.id } });
      if (!row) return res.status(404).json({ message: "Comentario no encontrado" });
      const me = req.user!;
      if (row.user_id !== me.id && me.global_role !== "admin") {
        return res.status(403).json({ message: "Solo el autor o un admin pueden borrarlo" });
      }
      await prisma.spotlightComment.delete({ where: { id: row.id } });
      // Sin esto quedaría un aviso apuntando a un comentario que ya no existe.
      await deleteNotificationsByRef(row.id);
      return res.json({ ok: true });
    } catch (e) { console.error("deleteComment", e); return res.status(500).json({ message: "Failed" }); }
  }
}
