import { prisma } from "../config/database.js";
import { env } from "../config/env.js";

export type NotifPayload = {
  type?: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Id del objeto que la originó, para poder retirarla si ese objeto se borra. */
  ref_id?: string | null;
};

/** Crea una notificación in-app para cada usuario (centro global / campanita). */
export async function createNotifications(userIds: string[], n: NotifPayload) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  await prisma.notification.createMany({
    data: ids.map((uid) => ({
      user_id: uid,
      type: n.type ?? "info",
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      ref_id: n.ref_id ?? null,
    })),
  });
}

/** Retira los avisos que apuntaban a un objeto ya borrado. */
export async function deleteNotificationsByRef(refId: string) {
  await prisma.notification.deleteMany({ where: { ref_id: refId } });
}

/** Todos los ids de usuario (para difusión company-wide). */
export async function allUserIds(): Promise<string[]> {
  const users = await prisma.user.findMany({ select: { id: true } });
  return users.map((u) => u.id);
}

/**
 * Dispara un webhook a n8n (fire-and-forget) que abanica a Gmail + Slack.
 * Un solo webhook con `event`; el flujo de n8n hace el switch. Nunca lanza.
 */
export async function fireSpotlightWebhook(event: string, payload: Record<string, unknown>) {
  if (!env.N8N_BASE_URL) return;
  try {
    await fetch(`${env.N8N_BASE_URL}/webhook/pkgd/spotlight`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
      body: JSON.stringify({ event, ...payload }),
    });
  } catch (e) {
    console.error("spotlight webhook error:", e);
  }
}
