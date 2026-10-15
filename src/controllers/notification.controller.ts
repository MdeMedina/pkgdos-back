import { Response } from "express";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";

const uid = (req: AuthenticatedRequest) => (req.user as any)?.id as string;

export class NotificationController {
  static async list(req: AuthenticatedRequest, res: Response) {
    try {
      const items = await prisma.notification.findMany({
        where: { user_id: uid(req) },
        orderBy: { created_at: "desc" },
        take: 50,
      });
      return res.json(items);
    } catch (e) { console.error("notif list", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async unreadCount(req: AuthenticatedRequest, res: Response) {
    try {
      const count = await prisma.notification.count({ where: { user_id: uid(req), read: false } });
      return res.json({ count });
    } catch (e) { console.error("notif count", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async markRead(req: AuthenticatedRequest, res: Response) {
    try {
      await prisma.notification.updateMany({ where: { id: req.params.id, user_id: uid(req) }, data: { read: true } });
      return res.json({ ok: true });
    } catch (e) { console.error("notif read", e); return res.status(500).json({ message: "Failed" }); }
  }

  static async markAllRead(req: AuthenticatedRequest, res: Response) {
    try {
      await prisma.notification.updateMany({ where: { user_id: uid(req), read: false }, data: { read: true } });
      return res.json({ ok: true });
    } catch (e) { console.error("notif read-all", e); return res.status(500).json({ message: "Failed" }); }
  }
}
