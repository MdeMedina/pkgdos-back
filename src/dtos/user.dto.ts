import { User, GlobalRole } from "@prisma/client";

export interface UserResponseDto {
  id: string;
  full_name: string;
  email: string;
  global_role: GlobalRole;
  friction_level?: number | null;
  calcification_level?: number | null;
  brand_access?: string[];
  brand_ids?: string[];
  created_at: string;
  updated_at: string;
}

export function toUserResponseDto(user: any, requestorRole?: GlobalRole): UserResponseDto {
  // If the user being mapped is an operator OR the logged-in user viewing it is an operator,
  // we must apply the Operator Blindness rule.
  const isOperator = requestorRole === "operator" || user.global_role === "operator";

  const dto: UserResponseDto = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    global_role: user.global_role,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };

  if (isOperator) {
    dto.friction_level = null;
    dto.calcification_level = null;
  } else {
    dto.friction_level = user.friction_level;
    dto.calcification_level = user.calcification_level;
  }

  if (user.brands) {
    const ids = user.brands.map((ub: any) => ub.brand_id);
    dto.brand_access = ids;
    dto.brand_ids = ids;
  } else {
    dto.brand_access = [];
    dto.brand_ids = [];
  }

  return dto;
}
