import { Router } from "express";
import authRoutes from "./auth.routes.js";
import userRoutes from "./user.routes.js";
import brandRoutes from "./brand.routes.js";
import sessionRoutes from "./session.routes.js";
import knowledgeRoutes from "./knowledge.routes.js";
import departmentRoutes from "./department.routes.js";
import companyRoutes from "./company.routes.js";
import driveRoutes from "./drive.routes.js";
import dropboxRoutes from "./dropbox.routes.js";
import pulseRoutes from "./pulse.routes.js";
import settingsRoutes from "./settings.routes.js";
import spotlightRoutes from "./spotlight.routes.js";
import notificationRoutes from "./notification.routes.js";

const apiRouter = Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", userRoutes);
apiRouter.use("/brands", brandRoutes);
apiRouter.use("/sessions", sessionRoutes);
apiRouter.use("/knowledge", knowledgeRoutes);
apiRouter.use("/departments", departmentRoutes);
apiRouter.use("/company", companyRoutes);
// Dropbox se monta ANTES que /drive para que su prefijo no lo capture el router de Drive.
apiRouter.use("/drive/dropbox", dropboxRoutes);
apiRouter.use("/drive", driveRoutes);
apiRouter.use("/pulse", pulseRoutes);
apiRouter.use("/settings", settingsRoutes);
apiRouter.use("/spotlight", spotlightRoutes);
apiRouter.use("/notifications", notificationRoutes);

export default apiRouter;
