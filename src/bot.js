require('./config'); // valida .env al arrancar — debe ser lo primero

const express         = require('express');
const supabase        = require('./services/supabase');
const whatsappRouter  = require('./routes/whatsapp');
const stripeRouter    = require('./routes/stripe');
const {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} = require('./config');

const app = express();

// ─── Rate limiting (in-memory, por IP) ───────────────────────────────────────
// Protege la Claude API de spam que dispare costos sin control.
const rateLimitMap = new Map();

app.use('/webhook/whatsapp', (req, res, next) => {
  if (req.method !== 'POST') return next();

  const ip  = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count++;
  rateLimitMap.set(ip, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`[RateLimit] IP bloqueada: ${ip} (${entry.count} req/min)`);
    return res.sendStatus(429);
  }

  next();
});

// ─── Archivos estáticos (landing page) ───────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/webhook/whatsapp', whatsappRouter);
app.use('/webhook/stripe',   stripeRouter);

// ─── Health check real ────────────────────────────────────────────────────────
// Verifica conectividad con Supabase — útil para monitores de uptime.
app.get('/health', async (_req, res) => {
  try {
    const { error } = await supabase
      .from('configuracion_estudio')
      .select('clave')
      .limit(1);
    if (error) throw error;
    res.json({ ok: true, ts: new Date().toISOString(), db: 'ok' });
  } catch (err) {
    console.error('[Health] Fallo en DB:', err.message);
    res.status(503).json({ ok: false, ts: new Date().toISOString(), db: err.message });
  }
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[Bot] Servidor corriendo en http://localhost:${PORT}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Espera a que los requests en vuelo terminen antes de cerrar.
// Evita citas huérfanas en Supabase al hacer deploys o reinicios.
function shutdown(signal) {
  console.log(`[Bot] ${signal} recibido — cerrando servidor...`);
  server.close(() => {
    console.log('[Bot] Servidor cerrado correctamente.');
    process.exit(0);
  });
  // Si después de 10s aún no cierra, forzar salida
  setTimeout(() => {
    console.error('[Bot] Timeout en shutdown — forzando salida.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
