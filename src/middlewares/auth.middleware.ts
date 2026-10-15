import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/database.js";
import { GlobalRole } from "@prisma/client";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    full_name: string;
    email: string;
    global_role: GlobalRole;
    friction_level: number;
    calcification_level: number;
    /** Departamento PRINCIPAL: clasifica propuestas nuevas y ordena la bandeja. */
    department_id: string | null;
    is_department_leader: boolean;
    /** Todos sus departamentos (incluido el principal), con la jefatura de cada uno. */
    departments: Array<{ department_id: string; is_leader: boolean }>;
    brands: Array<{ brand_id: string }>;
  };
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided, access denied" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        brands: {
          select: { brand_id: true }
        },
        departments: {
          select: { department_id: true, is_leader: true }
        },
        department: true,
        department_role: true,
      }
    });

    if (!user) {
      return res.status(401).json({ message: "Operator not found or session expired" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("JWT verification failed:", error);
    return res.status(401).json({ message: "Token invalid or expired" });
  }
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.global_role !== "admin") {
    return res.status(403).json({ message: "Directorate General access only" });
  }
  next();
}

export function requireN8N(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-n8n-token"];
  if (!token || token !== env.N8N_SECRET_TOKEN) {
    return res.status(403).json({ message: "Unauthorized server access" });
  }
  next();
}

// Allows either a logged-in operator (Bearer JWT, for the UI) OR the n8n service
// token (for agent tools calling read endpoints like the Drive tree).
export function requireAuthOrN8N(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers["x-n8n-token"];
  if (token && token === env.N8N_SECRET_TOKEN) return next();
  return requireAuth(req, res, next);
}

// ── Brand membership authorization ───────────────────────────────────────────
// No client-supplied brand_id is authoritative until validated against the
// authenticated user's `user_brands`.

type BrandContext = { isAdmin: boolean; brandIds: Set<string> };

// Resolve the brands the caller may access.
// - Operator (Bearer JWT): from req.user (brands are preloaded by requireAuth).
// - n8n service token: NOT authoritative on its own. The request MUST carry a
//   `user_id` (body or query) identifying the operator on whose behalf the agent
//   tool runs; membership is resolved from THAT user's user_brands. n8n agent
//   tools must forward the session's user_id.
export async function resolveBrandContext(req: Request): Promise<BrandContext | null> {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user) {
    return {
      isAdmin: authReq.user.global_role === "admin",
      brandIds: new Set(authReq.user.brands.map((b) => b.brand_id)),
    };
  }
  const n8nToken = req.headers["x-n8n-token"];
  if (n8nToken && n8nToken === env.N8N_SECRET_TOKEN) {
    const userId =
      ((req.body && req.body.user_id) as string | undefined) ??
      ((req.query && (req.query.user_id as string)) as string | undefined);
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { global_role: true, brands: { select: { brand_id: true } } },
    });
    if (!user) return null;
    return {
      isAdmin: user.global_role === "admin",
      brandIds: new Set(user.brands.map((b) => b.brand_id)),
    };
  }
  return null;
}

// True when the caller may access `brandId`. A null/undefined brand means the
// resource is unbranded (institutional/global) and is not brand-gated.
export function isBrandMember(ctx: BrandContext, brandId: string | null | undefined): boolean {
  if (ctx.isAdmin) return true;
  if (!brandId) return true;
  return ctx.brandIds.has(brandId);
}

// ── Department visibility context (Drive folder anchoring) ───────────────────
// A Drive folder anchored to N departments is visible only to users of those
// departments (or admins). Unanchored folders stay visible to everyone. This
// resolves WHO the caller is for that gate; the actual per-folder filtering
// lives in the Drive controller (it needs the folder→departments map).

// Un usuario puede pertenecer a varios departamentos y liderar varios. La
// visibilidad usa TODOS; la gestion destructiva, solo los que LIDERA.
export type DepartmentContext = {
  isAdmin: boolean;
  departmentIds: string[];
  leaderDepartmentIds: string[];
};

// Resolve the department the caller belongs to.
// - Operator (Bearer JWT): from req.user (loaded by requireAuth).
// - n8n service token: resolved from the forwarded ?user_id=/body.user_id of the
//   operator on whose behalf the agent runs. If it cannot be resolved (no user_id),
//   returns null and the caller SKIPS department filtering (the agent already gets a
//   brand-gated, truncated skeleton; department gating for agent tools is out of scope).
export async function resolveDepartmentContext(req: Request): Promise<DepartmentContext | null> {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user) {
    const dl = authReq.user.departments ?? [];
    return {
      isAdmin: authReq.user.global_role === "admin",
      departmentIds: dl.map((d) => d.department_id),
      leaderDepartmentIds: dl.filter((d) => d.is_leader).map((d) => d.department_id),
    };
  }
  const n8nToken = req.headers["x-n8n-token"];
  if (n8nToken && n8nToken === env.N8N_SECRET_TOKEN) {
    const userId =
      ((req.body && req.body.user_id) as string | undefined) ??
      ((req.query && (req.query.user_id as string)) as string | undefined);
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        global_role: true,
        departments: { select: { department_id: true, is_leader: true } },
      },
    });
    if (!user) return null;
    const dl = user.departments ?? [];
    return {
      isAdmin: user.global_role === "admin",
      departmentIds: dl.map((d) => d.department_id),
      leaderDepartmentIds: dl.filter((d) => d.is_leader).map((d) => d.department_id),
    };
  }
  return null;
}

// Middleware factory: gate an endpoint by a brand id derived from the request
// (e.g. req.params.brand_id). `getBrandId` may be async (e.g. to load a resource
// and read the brand of the RESOURCE rather than trusting a client value).
export function requireBrandMembership(
  getBrandId: (req: Request) => string | null | undefined | Promise<string | null | undefined>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await resolveBrandContext(req);
      if (!ctx) {
        return res
          .status(403)
          .json({ message: "Brand membership could not be verified (missing user context)" });
      }
      const brandId = await getBrandId(req);
      if (!isBrandMember(ctx, brandId)) {
        return res.status(403).json({ message: "You are not a member of this brand" });
      }
      next();
    } catch (error) {
      console.error("Brand membership check failed:", error);
      return res.status(500).json({ message: "Failed to verify brand membership" });
    }
  };
}

// Gate a Drive file endpoint (req.params.id) by the FILE's own brand — the brand
// is loaded server-side, never taken from the client.
export function requireDriveFileBrandMembership(req: Request, res: Response, next: NextFunction) {
  return (async () => {
    try {
      const ctx = await resolveBrandContext(req);
      if (!ctx) return res.status(403).json({ message: "Brand membership could not be verified" });
      const file = await prisma.driveFile.findUnique({
        where: { id: req.params.id },
        select: { brand_id: true },
      });
      if (!file) return res.status(404).json({ message: "File not found" });
      if (!isBrandMember(ctx, file.brand_id)) {
        return res.status(403).json({ message: "You are not a member of this file's brand" });
      }
      next();
    } catch (error) {
      console.error("Drive file membership check failed:", error);
      return res.status(500).json({ message: "Failed to verify file access" });
    }
  })();
}

// Gate a Drive folder endpoint (req.params.id) by the FOLDER's own brand.
export function requireDriveFolderBrandMembership(req: Request, res: Response, next: NextFunction) {
  return (async () => {
    try {
      const ctx = await resolveBrandContext(req);
      if (!ctx) return res.status(403).json({ message: "Brand membership could not be verified" });
      const folder = await prisma.driveFolder.findUnique({
        where: { id: req.params.id },
        select: { brand_id: true },
      });
      if (!folder) return res.status(404).json({ message: "Folder not found" });
      if (!isBrandMember(ctx, folder.brand_id)) {
        return res.status(403).json({ message: "You are not a member of this folder's brand" });
      }
      next();
    } catch (error) {
      console.error("Drive folder membership check failed:", error);
      return res.status(500).json({ message: "Failed to verify folder access" });
    }
  })();
}

// ── File-manager authorization (admin OR department leader) ──────────────────
// Move/rename/delete of Drive files, folders and versions is restricted to admins
// and to DEPARTMENT LEADERS acting inside a folder subtree anchored to their own
// department. Uploading/creating stays open to any brand member (handled by the
// brand-membership gates); only the destructive/mutating ops go through here.
//
// Leader scope (positive grant, a strict subset of what they can already SEE):
//   the target folder full_path, OR one of its ancestors, is anchored to the
//   leader's department in drive_folder_departments.
// Hard exclusion: /EXTERNAL DOWNLOADS (the Dropbox mirror) is admin-only — no
// leader may mutate anything there regardless of anchoring.
const EXTERNAL_DOWNLOADS_ROOT = "/EXTERNAL DOWNLOADS";

function isExternalDownloadsPath(fullPath: string): boolean {
  const p = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  return p === EXTERNAL_DOWNLOADS_ROOT || p.startsWith(`${EXTERNAL_DOWNLOADS_ROOT}/`);
}

// Does the department leader manage this folder path? True when the path (or an
// ancestor) is anchored to the leader's department. `folderFullPath` is a FOLDER
// path (always ends with "/"); for files, pass the containing folder's path.
async function leaderManagesFolderPath(
  user: { departments?: Array<{ department_id: string; is_leader: boolean }> },
  folderFullPath: string,
): Promise<boolean> {
  // Lidera N departamentos: puede gestionar el subarbol anclado a CUALQUIERA.
  const lidera = (user.departments ?? []).filter((d) => d.is_leader).map((d) => d.department_id);
  if (!lidera.length) return false;
  if (isExternalDownloadsPath(folderFullPath)) return false;

  const anchors = await prisma.$queryRaw<Array<{ full_path: string }>>`
    SELECT f.full_path
    FROM drive_folder_departments dfd
    JOIN drive_folders f ON f.id = dfd.folder_id
    WHERE dfd.department_id = ANY(${lidera}::uuid[])`;

  const target = folderFullPath.endsWith("/") ? folderFullPath : `${folderFullPath}/`;
  return anchors.some(({ full_path }) => {
    const anchor = full_path.endsWith("/") ? full_path : `${full_path}/`;
    return target === anchor || target.startsWith(anchor);
  });
}

// Gate a Drive FOLDER mutation (req.params.id) — admin OR qualifying leader.
// Assumes a brand-membership gate ran first (folder existence/brand already OK).
export function requireFolderManager(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  return (async () => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthenticated" });
      if (req.user.global_role === "admin") return next();
      const folder = await prisma.driveFolder.findUnique({
        where: { id: req.params.id },
        select: { full_path: true },
      });
      if (!folder) return res.status(404).json({ message: "Folder not found" });
      if (await leaderManagesFolderPath(req.user, folder.full_path)) return next();
      return res.status(403).json({ message: "Solo administradores o el líder del departamento pueden gestionar esta carpeta" });
    } catch (error) {
      console.error("Folder manager check failed:", error);
      return res.status(500).json({ message: "Failed to verify folder management permission" });
    }
  })();
}

// Gate a Drive FILE mutation (req.params.id) — admin OR qualifying leader. The
// containing folder's path is loaded server-side to evaluate leader scope.
export function requireFileManager(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  return (async () => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthenticated" });
      if (req.user.global_role === "admin") return next();
      const file = await prisma.driveFile.findUnique({
        where: { id: req.params.id },
        select: { full_path: true, folder: { select: { full_path: true } } },
      });
      if (!file) return res.status(404).json({ message: "File not found" });
      // A file at the Drive root (no folder) is admin-only for mutations.
      const folderPath = file.folder?.full_path ?? null;
      if (folderPath && (await leaderManagesFolderPath(req.user, folderPath))) return next();
      return res.status(403).json({ message: "Solo administradores o el líder del departamento pueden gestionar este archivo" });
    } catch (error) {
      console.error("File manager check failed:", error);
      return res.status(500).json({ message: "Failed to verify file management permission" });
    }
  })();
}

// ── Proposal scope (aprobaciones de Oro/Joya por área) ───────────────────────
// Regla acordada con la Directiva: Dirección General ve y aprueba TODAS las áreas
// (incluidas las propuestas sin área); cualquier otro operador —admin global o no—
// queda acotado al departamento que LIDERA. Quien no lidera un área no ve nada.
// Ojo: esto NO sigue a `global_role`. Un admin que no es de DG queda acotado aquí
// aunque siga siendo admin en el resto del OS; es deliberado.
const DG_DEPARTMENT_NAME = "Dirección General";
let dgDepartmentIdCache: string | null = null;

// Se cachea solo el acierto: si el departamento aún no existe se vuelve a buscar
// en la siguiente llamada, en vez de quedar clavado en null para siempre.
export async function directorateGeneralId(): Promise<string | null> {
  if (dgDepartmentIdCache) return dgDepartmentIdCache;
  const dept = await prisma.department.findFirst({
    where: { name: DG_DEPARTMENT_NAME },
    select: { id: true },
  });
  dgDepartmentIdCache = dept?.id ?? null;
  return dgDepartmentIdCache;
}

export type ProposalScope =
  | { kind: "all" }
  | { kind: "departments"; departmentIds: string[] }
  | { kind: "none" };

export async function resolveProposalScope(
  user: AuthenticatedRequest["user"],
): Promise<ProposalScope> {
  if (!user) return { kind: "none" };
  // Regla vigente (23-sep): TODO admin ve y aprueba todas las areas. Antes era
  // exclusivo de Direccion General; el usuario lo abrio deliberadamente.
  if (user.global_role === "admin") return { kind: "all" };
  const dgId = await directorateGeneralId();
  const mios = (user.departments ?? []).map((d) => d.department_id);
  if (dgId && mios.includes(dgId)) return { kind: "all" };
  const lidera = (user.departments ?? []).filter((d) => d.is_leader).map((d) => d.department_id);
  if (lidera.length) return { kind: "departments", departmentIds: lidera };
  return { kind: "none" };
}

// ¿Puede este alcance tocar una propuesta de `assetDepartmentId`? Una propuesta
// SIN área solo la ve DG (si no, quedaría huérfana y visible para cualquiera).
export function scopeCoversDepartment(
  scope: ProposalScope,
  assetDepartmentId: string | null,
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "departments") {
    return !!assetDepartmentId && scope.departmentIds.includes(assetDepartmentId);
  }
  return false;
}

// ── Session ownership (IDOR guard) ───────────────────────────────────────────
// Load the session by :id / :session_id and require the caller to own it (or be
// admin). Returns 404 for both missing and forbidden so existence is not revealed.
// The resolved session is stashed on req.session to avoid a reload downstream.
export async function requireSessionOwner(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthenticated" });
    const sessionId = (req.params.id ?? req.params.session_id) as string | undefined;
    if (!sessionId) return res.status(400).json({ message: "Session id is required" });

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || (session.user_id !== req.user.id && req.user.global_role !== "admin")) {
      return res.status(404).json({ message: "Session not found" });
    }
    (req as any).session = session;
    next();
  } catch (error) {
    console.error("Session ownership check failed:", error);
    return res.status(500).json({ message: "Failed to verify session ownership" });
  }
}
