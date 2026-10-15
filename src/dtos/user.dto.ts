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
  is_department_leader?: boolean;
  /** Todos sus departamentos, con la jefatura de cada uno. El principal es `department_id`. */
  departments?: Array<{ department_id: string; name?: string; is_leader: boolean; department_role_id?: string | null; role_name?: string | null }>;
  onboarding_completed?: boolean;
  can_view_labs?: boolean;
  is_lab_owner?: boolean;
  can_view_pulse?: boolean;
  can_view_sales?: boolean;
  /** Mapa de Roles: todos sus roles con tipo (primary | secondary | dynamic). */
  role_assignments?: Array<{ department_role_id: string; role_name: string; department_id: string; department_name: string; kind: string }>;
  can_view_ads?: boolean;
  photo_url?: string | null;
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
    is_department_leader: Boolean(user.is_department_leader),
    departments: Array.isArray((user as any).departments)
      ? (user as any).departments.map((d: any) => ({
          department_id: d.department_id,
          name: d.department?.name ?? undefined,
          is_leader: Boolean(d.is_leader),
          department_role_id: d.department_role_id ?? null,
          role_name: d.department_role?.name ?? null,
        }))
      : undefined,
    onboarding_completed: Boolean(user.onboarding_completed),
    can_view_labs: Boolean(user.can_view_labs),
    is_lab_owner: Boolean(user.is_lab_owner),
    can_view_pulse: Boolean(user.can_view_pulse),
    can_view_sales: Boolean(user.can_view_sales),
    can_view_ads: Boolean(user.can_view_ads),
    photo_url: user.photo_url ?? null,
    role_assignments: Array.isArray(user.role_assignments)
      ? user.role_assignments.map((a: any) => ({
          department_role_id: a.department_role_id,
          role_name: a.department_role?.name ?? "",
          department_id: a.department_role?.department_id ?? "",
          department_name: a.department_role?.department?.name ?? "",
          kind: a.kind,
        }))
      : undefined,
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
