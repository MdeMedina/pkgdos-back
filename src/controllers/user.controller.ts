import { Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { toUserResponseDto } from "../dtos/user.dto.js";

// Envía el correo de activación a través de n8n (nodo Gmail).
// Nunca lanza: si el correo falla, el alta del operador no debe abortarse.
async function sendActivationEmail(params: {
  email: string;
  full_name: string;
  token: string;
  // Textos opcionales para reutilizar el mismo correo en "restablecer contraseña".
  // Si no se envían, el nodo Gmail usa los textos de bienvenida/activación por defecto.
  subject?: string;
  heading?: string;
  intro?: string;
}): Promise<boolean> {
  const link = `${env.APP_BASE_URL}/set-password?token=${params.token}`;
  try {
    if (!env.N8N_BASE_URL) {
      console.warn("N8N_BASE_URL no definido; se omite el correo de activación.");
      return false;
    }
    const url = `${env.N8N_BASE_URL}/webhook/pkgd/send-activation`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-n8n-token": env.N8N_SECRET_TOKEN,
      },
      body: JSON.stringify({
        email: params.email,
        full_name: params.full_name,
        link,
        subject: params.subject ?? null,
        heading: params.heading ?? null,
        intro: params.intro ?? null,
      }),
    });
    if (!response.ok) {
      console.error(`Activation email webhook respondió ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Activation email webhook error:", error);
    return false;
  }
}

export class UserController {
  // Admin-only listing of all operators
  static async list(req: AuthenticatedRequest, res: Response) {
    try {
      const users = await prisma.user.findMany({
        include: {
          brands: true,
          departments: { include: { department: true, department_role: true } },
          role_assignments: { include: { department_role: { include: { department: true } } } },
          department: true,
          department_role: true,
        },
        orderBy: { created_at: "desc" },
      });

      const dtos = users.map((u) => toUserResponseDto(u, req.user?.global_role));
      return res.status(200).json(dtos);
    } catch (error) {
      console.error("List users error:", error);
      return res.status(500).json({ message: "Failed to list operators" });
    }
  }

  // Admin-only operator registration
  static async create(req: AuthenticatedRequest, res: Response) {
    try {
      const { full_name, email, global_role, brand_ids, department_id, department_role_id, can_view_sales, can_view_ads } = req.body;
      if (!full_name || !email || !global_role) {
        return res.status(400).json({ message: "Missing required operator fields" });
      }

      const existing = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });
      if (existing) {
        return res.status(400).json({ message: "Operator email already registered" });
      }

      // El operador se crea SIN contraseña utilizable: recibe un correo con un token
      // de activación y define su clave desde el link (auto-login). El password_hash
      // aleatorio garantiza que no se pueda entrar por login normal hasta activar.
      const passwordHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
      const sessionTokenN8n = `n8n.token.${Math.random().toString(36).substring(2, 10)}`;
      const activationToken = crypto.randomBytes(32).toString("hex");
      const activationExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

      // Use a transaction to link brands immediately
      const created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            full_name,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            global_role,
            session_token_n8n: sessionTokenN8n,
            activation_token: activationToken,
            activation_expires: activationExpires,
            friction_level: 0.0,
            calcification_level: 0.0,
            department_id: department_id || null,
            department_role_id: department_role_id || null,
            // Sales y Ads: permisos separados; se pueden otorgar desde el alta
            // (la ruta ya es admin-only).
            can_view_sales: Boolean(can_view_sales),
            can_view_ads: Boolean(can_view_ads),
          },
        });

        if (brand_ids && Array.isArray(brand_ids) && brand_ids.length > 0) {
          await tx.userBrand.createMany({
            data: brand_ids.map((bid: string) => ({
              user_id: user.id,
              brand_id: bid,
            })),
          });
        }

        return tx.user.findUnique({
          where: { id: user.id },
          include: {
            brands: true,
            departments: { include: { department: true, department_role: true } },
            role_assignments: { include: { department_role: { include: { department: true } } } },
            department: true,
            department_role: true,
          },
        });
      });

      // Disparar el correo de activación (vía n8n/Gmail). No bloquea el alta.
      const emailSent = await sendActivationEmail({
        email: created!.email,
        full_name: created!.full_name,
        token: activationToken,
      });

      return res
        .status(201)
        .json({ ...toUserResponseDto(created, req.user?.global_role), email_sent: emailSent });
    } catch (error) {
      console.error("Create user error:", error);
      return res.status(500).json({ message: "Failed to register operator" });
    }
  }

  // Admin-only updates
  static async update(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const { full_name, email, global_role, brand_ids, department_id, department_role_id, is_department_leader, can_view_labs, can_view_pulse, can_view_sales, can_view_ads, departments, role_assignments } = req.body;

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id },
          data: {
            full_name: full_name !== undefined ? full_name : undefined,
            email: email !== undefined ? email.toLowerCase() : undefined,
            global_role: global_role !== undefined ? global_role : undefined,
            department_id: department_id !== undefined ? (department_id || null) : undefined,
            department_role_id: department_role_id !== undefined ? (department_role_id || null) : undefined,
            is_department_leader:
              is_department_leader !== undefined ? Boolean(is_department_leader) : undefined,
            // Solo el dueño del laboratorio puede cambiar este permiso; para cualquier
            // otro admin el campo se ignora (no rompe la edición del resto).
            can_view_labs:
              can_view_labs !== undefined && (req.user as any)?.is_lab_owner
                ? Boolean(can_view_labs)
                : undefined,
            // Quincenal Pulse: rama aparte, permiso por-usuario. Cualquier admin
            // (esta ruta ya es admin-only) puede otorgar/quitar el acceso.
            can_view_pulse:
              can_view_pulse !== undefined ? Boolean(can_view_pulse) : undefined,
            // Sales y Ads, cada uno con su permiso. Mismo criterio que Pulse:
            // cualquier admin lo otorga o lo quita.
            can_view_sales: can_view_sales !== undefined ? Boolean(can_view_sales) : undefined,
            can_view_ads: can_view_ads !== undefined ? Boolean(can_view_ads) : undefined,
          },
        });

        // departments = [{ department_id, is_leader, department_role_id? }]. Reemplaza el set completo.
        // `department_id` (arriba) sigue siendo el PRINCIPAL y se añade solo si no
        // viene en la lista, para que nunca quede fuera de sus propios departamentos.
        if (Array.isArray(role_assignments)) {
          // role_assignments = [{ department_role_id, kind }]. Reemplaza el set completo y
          // de ahí se derivan la membresía (user_departments) y la jefatura.
          const KINDS = ["primary", "secondary", "dynamic"];
          const pedidas = role_assignments.filter(
            (a: any) => a && typeof a.department_role_id === "string" && KINDS.includes(a.kind),
          ) as Array<{ department_role_id: string; kind: string }>;
          const ids = [...pedidas.map((a) => a.department_role_id), ...(u.department_role_id ? [u.department_role_id] : [])];
          const roles = ids.length
            ? await tx.departmentRole.findMany({ where: { id: { in: ids } }, select: { id: true, department_id: true } })
            : [];
          const deptDe = new Map(roles.map((r) => [r.id, r.department_id]));
          const asign = [
            ...new Map(
              pedidas
                .filter((a) => deptDe.has(a.department_role_id))
                .map((a) => [a.department_role_id, { department_role_id: a.department_role_id, kind: a.kind }]),
            ).values(),
          ];
          // El rol principal (users.department_role_id) siempre figura como primario.
          if (u.department_role_id && deptDe.has(u.department_role_id)) {
            const p = asign.find((a) => a.department_role_id === u.department_role_id);
            if (p) p.kind = "primary";
            else asign.push({ department_role_id: u.department_role_id, kind: "primary" });
          }
          await tx.userRoleAssignment.deleteMany({ where: { user_id: id } });
          if (asign.length) {
            await tx.userRoleAssignment.createMany({ data: asign.map((a) => ({ user_id: id, ...a })) });
          }

          // Membresía: departamento principal + los que tengan un rol primario o
          // secundario. El rol dinámico no da membresía (no implica juntas ni carpetas).
          const previos = await tx.userDepartment.findMany({ where: { user_id: id } });
          const liderPedido = new Map<string, boolean>(
            (Array.isArray(departments) ? departments : [])
              .filter((d: any) => d && typeof d.department_id === "string")
              .map((d: any) => [d.department_id, Boolean(d.is_leader)]),
          );
          const principal = u.department_id;
          const deptos = new Map<string, string | null>();
          if (principal) deptos.set(principal, u.department_role_id ?? null);
          for (const a of asign) {
            if (a.kind === "dynamic") continue;
            const d = deptDe.get(a.department_role_id)!;
            if (!deptos.has(d) || deptos.get(d) === null) deptos.set(d, a.department_role_id);
          }
          const liderDe = (d: string) =>
            liderPedido.has(d)
              ? liderPedido.get(d)!
              : d === principal && is_department_leader !== undefined
                ? Boolean(is_department_leader)
                : Boolean(previos.find((p) => p.department_id === d)?.is_leader);
          await tx.userDepartment.deleteMany({ where: { user_id: id } });
          if (deptos.size) {
            await tx.userDepartment.createMany({
              data: [...deptos].map(([d, r]) => ({ user_id: id, department_id: d, department_role_id: r, is_leader: liderDe(d) })),
            });
          }
          await tx.user.update({ where: { id }, data: { is_department_leader: principal ? liderDe(principal) : false } });
        } else if (departments && Array.isArray(departments)) {
          const limpio = departments
            .filter((d: any) => d && typeof d.department_id === "string" && d.department_id)
            .map((d: any) => ({
              department_id: d.department_id as string,
              is_leader: Boolean(d.is_leader),
              department_role_id: (typeof d.department_role_id === "string" && d.department_role_id) ? d.department_role_id as string : null,
            }));
          const principal = department_id !== undefined ? (department_id || null) : u.department_id;
          if (principal && !limpio.some((d) => d.department_id === principal)) {
            limpio.push({ department_id: principal, is_leader: Boolean(u.is_department_leader), department_role_id: null });
          }
          // El rol del principal es siempre el de `users.department_role_id` (fuente única).
          for (const d of limpio) if (d.department_id === principal) d.department_role_id = u.department_role_id ?? null;
          // Un rol solo vale si pertenece a ese departamento; si no, se descarta.
          const rolIds = limpio.map((d) => d.department_role_id).filter((x): x is string => !!x);
          const roles = rolIds.length
            ? await tx.departmentRole.findMany({ where: { id: { in: rolIds } }, select: { id: true, department_id: true } })
            : [];
          for (const d of limpio) {
            if (d.department_role_id && !roles.some((r) => r.id === d.department_role_id && r.department_id === d.department_id)) {
              d.department_role_id = null;
            }
          }
          const unicos = [...new Map(limpio.map((d) => [d.department_id, d])).values()];
          await tx.userDepartment.deleteMany({ where: { user_id: id } });
          if (unicos.length) {
            await tx.userDepartment.createMany({
              data: unicos.map((d) => ({ user_id: id, department_id: d.department_id, is_leader: d.is_leader, department_role_id: d.department_role_id })),
            });
          }
          // `is_department_leader` refleja la jefatura del departamento PRINCIPAL.
          const jefePrincipal = principal ? unicos.find((d) => d.department_id === principal)?.is_leader : false;
          await tx.user.update({ where: { id }, data: { is_department_leader: Boolean(jefePrincipal) } });
        } else if (department_id !== undefined) {
          // Edición antigua (solo cambia el principal): se reemplaza SOLO la fila del
          // principal anterior; las membresías secundarias se conservan.
          const nuevo = department_id || null;
          if (user.department_id && user.department_id !== nuevo) {
            await tx.userDepartment.deleteMany({ where: { user_id: id, department_id: user.department_id } });
          }
          if (nuevo) {
            await tx.userDepartment.upsert({
              where: { user_id_department_id: { user_id: id, department_id: nuevo } },
              create: { user_id: id, department_id: nuevo, department_role_id: u.department_role_id ?? null, is_leader: Boolean(is_department_leader) },
              update: { department_role_id: u.department_role_id ?? null, is_leader: Boolean(is_department_leader) },
            });
          }
        }

        if (!Array.isArray(role_assignments) && department_role_id !== undefined && u.department_role_id !== user.department_role_id) {
          // Cambió el rol principal por la vía antigua: la asignación primaria lo sigue.
          if (user.department_role_id) {
            await tx.userRoleAssignment.deleteMany({ where: { user_id: id, department_role_id: user.department_role_id, kind: "primary" } });
          }
          if (u.department_role_id) {
            await tx.userRoleAssignment.upsert({
              where: { user_id_department_role_id: { user_id: id, department_role_id: u.department_role_id } },
              create: { user_id: id, department_role_id: u.department_role_id, kind: "primary" },
              update: { kind: "primary" },
            });
          }
        }

        if (brand_ids && Array.isArray(brand_ids)) {
          // Clear current brands and re-insert
          await tx.userBrand.deleteMany({ where: { user_id: id } });
          await tx.userBrand.createMany({
            data: brand_ids.map((bid: string) => ({
              user_id: id,
              brand_id: bid,
            })),
          });
        }

        return tx.user.findUnique({
          where: { id },
          include: {
            brands: true,
            departments: { include: { department: true, department_role: true } },
            role_assignments: { include: { department_role: { include: { department: true } } } },
            department: true,
            department_role: true,
          },
        });
      });

      return res.status(200).json(toUserResponseDto(updated, req.user?.global_role));
    } catch (error) {
      console.error("Update user error:", error);
      return res.status(500).json({ message: "Failed to update operator" });
    }
  }

  // Admin-only deletion
  static async delete(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      await prisma.user.delete({ where: { id } });
      return res.status(200).json({ ok: true, message: "Operator deleted successfully" });
    } catch (error) {
      console.error("Delete user error:", error);
      return res.status(500).json({ message: "Failed to delete operator" });
    }
  }

  // Admin-only get operator diagnostic
  static async getDiagnostic(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        return res.status(404).json({ message: "Operator not found" });
      }

      const sessions = await prisma.session.findMany({
        where: { user_id: id },
      });

      const max_friction = sessions.reduce((max, s) => Math.max(max, s.friction_level), 0);
      const encauzamiento_count = sessions.reduce((sum, s) => sum + s.encauzamiento_count, 0);
      const coupling_node_count = sessions.filter((s) => s.coupling_node_triggered).length;

      // Extract all glitches from sessions
      const glitches: any[] = [];
      sessions.forEach((s) => {
        if (s.glitches && Array.isArray(s.glitches)) {
          glitches.push(...s.glitches);
        }
      });

      const glitch_count = glitches.length;
      const score =
        glitch_count === 0
          ? 6.0
          : Math.round(
              (glitches.reduce((sum, g) => sum + (g.score || 0), 0) / glitch_count) * 10
            ) / 10;

      // El diagnóstico narrativo lo genera el motor n8n (sub-workflow
      // PKGD - Diagnóstico de Usuario) en cada cierre y se persiste en
      // user_diagnostics. Tomamos el más reciente. El bloque rule-based de abajo
      // queda solo como fallback para operadores que aún no tienen diagnóstico.
      const latest = await prisma.userDiagnostic.findFirst({
        where: { user_id: id },
        orderBy: { created_at: "desc" },
      });

      let fallbackText =
        "Operación estable. Fricción dentro de rango, sin glitches críticos. Sin acción requerida.";
      if (encauzamiento_count >= 3 && score >= 5) {
        fallbackText =
          "Operador en encauzamiento sostenido. Capacidad demostrada de cortar el bucle defensivo y nombrar la variable. Apto para extracción de Oro Estructural.";
      } else if (max_friction >= 7 && score < 5) {
        fallbackText =
          "Alta fricción con baja resolución. El operador resiste el corte; predominan glitches sin reformulación. Intervenir antes de calcificar.";
      } else if (coupling_node_count > 0) {
        fallbackText =
          "Nodo de acoplamiento activo. La conversación tocó estructura. Monitorear si el próximo intervalo produce encauzamiento.";
      }

      return res.status(200).json({
        text: latest?.summary?.trim() ? latest.summary : fallbackText,
        payload: latest?.payload ?? null,
        generated_at: latest?.created_at ?? null,
        trigger_reason: latest?.trigger_reason ?? null,
        score,
        max_friction,
        encauzamiento_count,
        glitch_count,
        coupling_node_count,
        glitches,
      });
    } catch (error) {
      console.error("Get operator diagnostic error:", error);
      return res.status(500).json({ message: "Failed to fetch operational diagnostics" });
    }
  }

  // POST /users/me/onboarding-complete — el operador terminó (o saltó) el tour guiado.
  // Marca su propio flag; no requiere admin (cada quien cierra su propio onboarding).
  static async completeOnboarding(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthenticated" });
      await prisma.user.update({
        where: { id: req.user.id },
        data: { onboarding_completed: true },
      });
      return res.status(200).json({ ok: true, onboarding_completed: true });
    } catch (error) {
      console.error("Complete onboarding error:", error);
      return res.status(500).json({ message: "Failed to complete onboarding" });
    }
  }

  // POST /users/:id/reset-password — (admin) reenvía al usuario un link para volver a
  // definir su contraseña. Reusa el mismo mecanismo de activación: emite un token nuevo
  // (invalidando el anterior) y manda el correo con textos de "restablecer".
  static async resetPassword(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ message: "Operator not found" });

      const activationToken = crypto.randomBytes(32).toString("hex");
      const activationExpires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h
      await prisma.user.update({
        where: { id },
        data: { activation_token: activationToken, activation_expires: activationExpires },
      });

      const emailSent = await sendActivationEmail({
        email: user.email,
        full_name: user.full_name,
        token: activationToken,
        subject: "Restablece tu contraseña · PKGD OS",
        heading: `Hola, ${user.full_name}`,
        intro:
          "Un administrador solicitó restablecer tu contraseña. Define una nueva con el siguiente enlace (válido 48 horas).",
      });

      return res.status(200).json({ ok: true, email_sent: emailSent });
    } catch (error) {
      console.error("Reset password error:", error);
      return res.status(500).json({ message: "Failed to send password reset" });
    }
  }
}
