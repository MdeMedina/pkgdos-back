import { Response } from "express";
import { AuthService } from "../services/auth.service.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { toUserResponseDto } from "../dtos/user.dto.js";

export class AuthController {
  static async login(req: any, res: Response) {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const result = await AuthService.login(email, password);
      return res.status(200).json(result);
    } catch (error: any) {
      console.error("Login controller error:", error);
      const status = error.status || 500;
      return res.status(status).json({ message: error.message || "Authentication failed" });
    }
  }

  static async me(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated" });
      }
      
      // Pass the user's role to properly trigger operator blindness rules
      const userDto = toUserResponseDto(req.user, req.user.global_role);
      return res.status(200).json(userDto);
    } catch (error: any) {
      console.error("Profile controller error:", error);
      return res.status(500).json({ message: "Failed to retrieve profile" });
    }
  }

  static async logout(req: AuthenticatedRequest, res: Response) {
    return res.status(200).json({ ok: true, message: "Logged out successfully" });
  }
}
