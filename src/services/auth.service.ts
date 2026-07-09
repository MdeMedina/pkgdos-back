import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { toUserResponseDto, UserResponseDto } from "../dtos/user.dto.js";

export interface LoginResult {
  token: string;
  user: UserResponseDto;
}

export class AuthService {
  static async login(email: string, password: string): Promise<LoginResult> {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        brands: {
          select: { brand_id: true }
        },
        department: true,
        department_role: true,
      }
    });

    if (!user) {
      throw Object.assign(new Error("Unknown operator"), { status: 401 });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      throw Object.assign(new Error("Invalid access key"), { status: 401 });
    }

    return AuthService.issueSession(user);
  }

  /**
   * Valida un token de activación (usuario recién creado que aún no tiene clave).
   * Devuelve datos mínimos para que el front muestre a quién pertenece la cuenta.
   */
  static async getActivation(token: string): Promise<{ email: string; full_name: string }> {
    if (!token) {
      throw Object.assign(new Error("Missing activation token"), { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { activation_token: token },
    });

    if (!user) {
      throw Object.assign(new Error("Invalid activation token"), { status: 400 });
    }
    if (user.activation_expires && user.activation_expires.getTime() < Date.now()) {
      throw Object.assign(new Error("Activation token expired"), { status: 410 });
    }

    return { email: user.email, full_name: user.full_name };
  }

  /**
   * Fija la contraseña de un usuario a partir de su token de activación,
   * consume el token y devuelve una sesión iniciada (auto-login).
   */
  static async setPassword(token: string, password: string): Promise<LoginResult> {
    if (!token) {
      throw Object.assign(new Error("Missing activation token"), { status: 400 });
    }
    if (!password || password.length < 8) {
      throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
    }

    const existing = await prisma.user.findUnique({
      where: { activation_token: token },
    });

    if (!existing) {
      throw Object.assign(new Error("Invalid activation token"), { status: 400 });
    }
    if (existing.activation_expires && existing.activation_expires.getTime() < Date.now()) {
      throw Object.assign(new Error("Activation token expired"), { status: 410 });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        password_hash: passwordHash,
        activation_token: null,
        activation_expires: null,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: existing.id },
      include: {
        brands: { select: { brand_id: true } },
        department: true,
        department_role: true,
      },
    });

    return AuthService.issueSession(user!);
  }

  /**
   * Emite JWT (24h) y garantiza que el usuario tenga session_token_n8n.
   * Compartido por login y set-password.
   */
  private static async issueSession(user: any): Promise<LoginResult> {
    const token = jwt.sign({ userId: user.id }, env.JWT_SECRET, {
      expiresIn: "24h",
    });

    if (!user.session_token_n8n) {
      const sessionTokenN8n = `n8n.token.${Math.random().toString(36).substring(2, 10)}`;
      await prisma.user.update({
        where: { id: user.id },
        data: { session_token_n8n: sessionTokenN8n },
      });
      user.session_token_n8n = sessionTokenN8n;
    }

    return {
      token,
      user: toUserResponseDto(user),
    };
  }
}
