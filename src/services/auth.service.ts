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

    return {
      token,
      user: toUserResponseDto(user),
    };
  }
}
