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
        }
      }
    });

    if (!user) {
      throw Object.assign(new Error("Unknown operator"), { status: 401 });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      throw Object.assign(new Error("Invalid access key"), { status: 401 });
    }

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
