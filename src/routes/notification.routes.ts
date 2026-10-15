import { Router } from "express";
import { NotificationController } from "../controllers/notification.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/", requireAuth, NotificationController.list);
router.get("/unread-count", requireAuth, NotificationController.unreadCount);
router.post("/read-all", requireAuth, NotificationController.markAllRead);
router.post("/:id/read", requireAuth, NotificationController.markRead);

export default router;
