import { Response, Request } from "express";
import { prisma } from "../config/database.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";

export class SessionController {
  // Get active operator's sessions
  static async mySessions(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Unauthenticated" });
      }

      const sessions = await prisma.session.findMany({
        where: { user_id: req.user.id },
        orderBy: { updated_at: "desc" },
      });
      return res.status(200).json(sessions);
    } catch (error) {
      console.error("My sessions list error:", error);
      return res.status(500).json({ message: "Failed to list your sessions" });
    }
  }

  // Create session (hilo conversacional)
  static async create(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Unauthenticated" });
      }

      const { brand_id, title } = req.body;
      if (!title) {
        return res.status(400).json({ message: "Session title is required" });
      }

      // Inherit initial values from operator profile
      const session = await prisma.session.create({
        data: {
          user_id: req.user.id,
          brand_id: brand_id || null,
          title,
          status: "Open",
          friction_level: 0.0,
          calcification_delta: 0.0,
          interval_count: 0,
          glitch_count: 0,
          encauzamiento_count: 0,
          coupling_node_triggered: false,
          resolution_status: "Unresolved",
          gold_extraction_status: "None",
          transcript_payload: [],
          glitches: [],
        },
      });

      return res.status(201).json(session);
    } catch (error) {
      console.error("Create session error:", error);
      return res.status(500).json({ message: "Failed to initialize dialectic session" });
    }
  }

  // List all sessions (admin only)
  static async listAll(req: AuthenticatedRequest, res: Response) {
    try {
      const sessions = await prisma.session.findMany({
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(sessions);
    } catch (error) {
      console.error("List all sessions error:", error);
      return res.status(500).json({ message: "Failed to list sessions" });
    }
  }

  // Get single session detail (telemetry + transcript)
  static async get(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const session = await prisma.session.findUnique({
        where: { id },
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      return res.status(200).json(session);
    } catch (error) {
      console.error("Get session error:", error);
      return res.status(500).json({ message: "Failed to fetch session detail" });
    }
  }

  // Reopen session
  static async reopen(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await prisma.session.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Session not found" });
      }

      const session = await prisma.session.update({
        where: { id },
        data: {
          status: "Open",
          updated_at: new Date(),
        },
      });
      return res.status(200).json(session);
    } catch (error) {
      console.error("Reopen session error:", error);
      return res.status(500).json({ message: "Failed to reopen session" });
    }
  }

  // Approve & integrate session (admin only)
  static async integrate(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await prisma.session.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Session not found" });
      }

      const session = await prisma.session.update({
        where: { id },
        data: {
          integration_signal_received_at: new Date(),
          gold_extraction_status: "Pending",
        },
      });
      return res.status(200).json(session);
    } catch (error) {
      console.error("Integrate session error:", error);
      return res.status(500).json({ message: "Failed to integrate session" });
    }
  }

  // Close session callback (n8n Webhook)
  static async close(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const {
        friction_level,
        calcification_delta,
        interval_count,
        glitch_count,
        encauzamiento_count,
        coupling_node_triggered,
        resolution_status,
        transcript_payload,
        glitches,
      } = req.body;

      const existing = await prisma.session.findUnique({
        where: { id },
        include: { user: true },
      });
      if (!existing) {
        return res.status(404).json({ message: "Session not found" });
      }

      // Update session values
      const session = await prisma.session.update({
        where: { id },
        data: {
          status: "Closed",
          friction_level: friction_level !== undefined ? friction_level : existing.friction_level,
          calcification_delta: calcification_delta !== undefined ? calcification_delta : existing.calcification_delta,
          interval_count: interval_count !== undefined ? interval_count : existing.interval_count,
          glitch_count: glitch_count !== undefined ? glitch_count : existing.glitch_count,
          encauzamiento_count: encauzamiento_count !== undefined ? encauzamiento_count : existing.encauzamiento_count,
          coupling_node_triggered: coupling_node_triggered !== undefined ? coupling_node_triggered : existing.coupling_node_triggered,
          resolution_status: resolution_status !== undefined ? resolution_status : existing.resolution_status,
          transcript_payload: transcript_payload !== undefined ? transcript_payload : existing.transcript_payload,
          glitches: glitches !== undefined ? glitches : existing.glitches,
          updated_at: new Date(),
        },
      });

      // Recalculate operator fatigue (updates users.friction_level & users.calcification_level)
      if (existing.user) {
        const userSessions = await prisma.session.findMany({
          where: { user_id: existing.user_id },
        });
        
        // Aggregate max friction & sum calcification deltas
        const maxFriction = userSessions.reduce((max, s) => Math.max(max, s.friction_level), 0);
        const sumCalcification = userSessions.reduce((sum, s) => sum + s.calcification_delta, 0);

        await prisma.user.update({
          where: { id: existing.user_id },
          data: {
            friction_level: maxFriction,
            calcification_level: sumCalcification,
          },
        });
      }

      return res.status(200).json(session);
    } catch (error) {
      console.error("Close session webhook error:", error);
      return res.status(500).json({ message: "Failed to process session closing" });
    }
  }

  // Get session transcript messages
  static async getMessages(req: Request, res: Response) {
    try {
      const { session_id } = req.params;
      const session = await prisma.session.findUnique({
        where: { id: session_id },
        select: { transcript_payload: true },
      });

      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      return res.status(200).json(session.transcript_payload);
    } catch (error) {
      console.error("Get messages error:", error);
      return res.status(500).json({ message: "Failed to retrieve messages" });
    }
  }
}
