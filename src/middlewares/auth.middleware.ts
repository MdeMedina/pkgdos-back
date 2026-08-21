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
    department_id: string | null;
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

export type DepartmentContext = { isAdmin: boolean; departmentId: string | null };

// Resolve the department the caller belongs to.
// - Operator (Bearer JWT): from req.user (loaded by requireAuth).
// - n8n service token: resolved from the forwarded ?user_id=/body.user_id of the
//   operator on whose behalf the agent runs. If it cannot be resolved (no user_id),
//   returns null and the caller SKIPS department filtering (the agent already gets a
//   brand-gated, truncated skeleton; department gating for agent tools is out of scope).
export async function resolveDepartmentContext(req: Request): Promise<DepartmentContext | null> {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user) {
    return {
      isAdmin: authReq.user.global_role === "admin",
      departmentId: authReq.user.department_id ?? null,
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
      select: { global_role: true, department_id: true },
    });
    if (!user) return null;
    return { isAdmin: user.global_role === "admin", departmentId: user.department_id ?? null };
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
