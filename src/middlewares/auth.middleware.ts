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
        }
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
