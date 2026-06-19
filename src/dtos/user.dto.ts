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
  department_id?: string | null;
  department_role_id?: string | null;
  department?: { id: string; name: string } | null;
  department_role?: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
}

export function toUserResponseDto(user: any, requestorRole?: GlobalRole): UserResponseDto {
  // Operator Blindness: an operator must never see friction/calcification scores,
  // including their own (used by /me). Admins see telemetry for every user —
  // operator or admin alike — e.g. on /api/users.
  const blindRequestor = requestorRole === "operator";

  const dto: UserResponseDto = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    global_role: user.global_role,
    department_id: user.department_id,
    department_role_id: user.department_role_id,
    department: user.department ? { id: user.department.id, name: user.department.name } : null,
    department_role: user.department_role ? { id: user.department_role.id, name: user.department_role.name } : null,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };

  if (blindRequestor) {
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
