require('dotenv').config();

// ─── Validar variables de entorno al arrancar ─────────────────────────────────
// Si falta alguna, el proceso termina con mensaje claro en lugar de explotar
// en medio de un request.

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'CLAUDE_API_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_CREDENTIALS_PATH',
  'GOOGLE_CALENDAR_ID',
  'BASE_URL',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[Config] ❌ Variables de entorno faltantes: ${missing.join(', ')}`);
  console.error('[Config] Revisa tu archivo .env (ver .env.example)');
  process.exit(1);
}

// ─── Constantes globales ──────────────────────────────────────────────────────

module.exports = {
  GRAPH_API_VERSION:     'v21.0',
  CLAUDE_MODEL:          'claude-sonnet-4-6',
  TIMEZONE:              'America/Monterrey',
  SESSION_TIMEOUT_HORAS: 4,     // inactividad para resetear contexto
  MAX_HISTORIAL:         20,    // últimos N mensajes que se mandan a Claude
  ANTICIPO_PCT:          0.20,  // 20% de anticipo
  STRIPE_EXPIRY_MIN:     30,    // minutos para que expire el link de pago
  DEDUP_TTL_MS:          10 * 60 * 1000, // TTL de deduplicación de mensajes
  MSG_MAX_AGE_MS:        3 * 60 * 1000,  // ignorar mensajes con >3 min de antigüedad (reintentos de Meta)
  RATE_LIMIT_MAX:        20,    // máx mensajes por IP por ventana
  RATE_LIMIT_WINDOW_MS:  60_000, // ventana de rate limit (1 min)
};
