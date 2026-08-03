import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";

/**
 * Quincenal Pulse — proxy autenticado.
 *
 * El dashboard vive dentro de PKGD OS (ruta /pulse) pero sus datos siguen en el
 * backend de Quincenal Pulse (Express + SQLite + Windsor.ai), que se mantiene
 * como fuente única. Este router traduce la sesión de PKGD OS (JWT de operador,
 * solo Dirección General) a la autenticación máquina-a-máquina que ese backend
 * ya soporta (header `x-api-key`), así no hay que tocar Firebase ni exponer el
 * servicio a internet: escucha solo en loopback.
 *
 *   GET /api/pulse/meta  →  GET http://127.0.0.1:4000/api/meta
 */
const router = Router();

// La barrera real: sin JWT de admin no se llega al upstream.
router.use(requireAuth, requireAdmin);

router.all(/.*/, async (req, res) => {
  // req.url dentro de un router montado ya viene sin el prefijo /api/pulse.
  const upstream = `${env.PULSE_API_URL}/api${req.url}`;

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && req.body !== undefined;

  try {
    const upstreamRes = await fetch(upstream, {
      method,
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(env.PULSE_API_KEY ? { "x-api-key": env.PULSE_API_KEY } : {}),
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
      // El sync de Windsor y la generación de notas [IA] pueden tardar.
      signal: AbortSignal.timeout(120_000),
    });

    const text = await upstreamRes.text();
    res.status(upstreamRes.status);
    res.type(upstreamRes.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (error) {
    console.error("Pulse proxy error:", req.method, upstream, error);
    return res.status(502).json({
      message: "Quincenal Pulse no responde (backend de datos caído o inalcanzable)",
    });
  }
});

export default router;
