import { Router } from "express";
import authRoutes from "./auth.routes.js";
import userRoutes from "./user.routes.js";
import brandRoutes from "./brand.routes.js";
import sessionRoutes from "./session.routes.js";
import knowledgeRoutes from "./knowledge.routes.js";

const apiRouter = Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", userRoutes);
apiRouter.use("/brands", brandRoutes);
apiRouter.use("/sessions", sessionRoutes);
apiRouter.use("/knowledge", knowledgeRoutes);

export default apiRouter;
