# Tattoo Bot

## Stack
- Base de datos: Supabase (PostgreSQL)
- IA: Claude API (claude-sonnet-4-6)
- Mensajería: WhatsApp Business API
- Pagos: Stripe
- Calendario: Google Calendar API
- Proceso: PM2

## Credenciales
Todas las keys están en `.env` — nunca hardcodear. Ver `.env.example` para la lista completa.

---

## Estructura del proyecto

```
src/
  config.js          ← validación de .env al arrancar + todas las constantes globales
  bot.js             ← entry point: express, rate limiting, health check, graceful shutdown
  routes/
    whatsapp.js      ← GET + POST /webhook/whatsapp (cola, dedup, procesamiento)
    stripe.js        ← POST /webhook/stripe (pago completado, sesión expirada + notificaciones WA)
  services/
    supabase.js      ← singleton del cliente Supabase (importar desde aquí, nunca re-instanciar)
    stripe.js        ← singleton del cliente Stripe   (importar desde aquí, nunca re-instanciar)
    whatsapp.js      ← normalizePhone(), sendMessage(), downloadMedia() — con timeout 10s
    claude.js        ← TOOL_CREAR_PAGO, buildSystemPrompt(), callClaude() — con reintentos
    calendar.js      ← createCitaEvent()
supabase/
  tattoo_schema.sql  ← schema base
  migration_pagos.sql← tarifas, pagos, funciones RPC
n8n/
  flujo_expirar_pagos.json      ← Schedule cada 2 min → expirar_pagos_vencidos()
  flujo_confirmacion_stripe.json← Webhook Stripe → confirmar_pago_stripe()
```

## Tablas principales
`clientes`, `citas`, `conversaciones`, `tarifas`, `pagos`, `recordatorios`, `disponibilidad_bloqueada`, `configuracion_estudio`

---

## Estándares de código

### Regla #1 — Separación de responsabilidades
Cada archivo tiene UNA sola responsabilidad:
- `config.js` — configuración y constantes
- `services/` — lógica de negocio y llamadas a APIs externas (sin Express)
- `routes/` — handlers HTTP (sin lógica de negocio embebida)
- `bot.js` — solo ensambla el servidor

**Nunca mezclar lógica de negocio dentro de un handler de Express.**
Si una función crece más de ~40 líneas dentro de un route handler, extraerla a `services/`.

### Regla #2 — Constantes en config.js
**Ningún número mágico o string hardcodeado en el código.**
Todos los valores configurables van en `src/config.js`:

```js
// ✅ Correcto
const { STRIPE_EXPIRY_MIN, CLAUDE_MODEL } = require('../config');

// ❌ Incorrecto
expires_at: Date.now() + 30 * 60
```

Constantes actuales en `config.js`:
| Constante | Valor | Descripción |
|-----------|-------|-------------|
| `GRAPH_API_VERSION` | `'v21.0'` | Versión Graph API de Meta |
| `CLAUDE_MODEL` | `'claude-sonnet-4-6'` | Modelo de Claude a usar |
| `TIMEZONE` | `'America/Monterrey'` | Zona horaria del estudio |
| `SESSION_TIMEOUT_HORAS` | `4` | Horas de inactividad para resetear sesión |
| `MAX_HISTORIAL` | `20` | Últimos N mensajes enviados a Claude |
| `ANTICIPO_PCT` | `0.20` | Porcentaje de anticipo (20%) |
| `STRIPE_EXPIRY_MIN` | `30` | Minutos de validez del link de pago |
| `DEDUP_TTL_MS` | `600_000` | TTL de deduplicación de mensajes (10 min) |
| `RATE_LIMIT_MAX` | `20` | Máx requests por IP por ventana |
| `RATE_LIMIT_WINDOW_MS` | `60_000` | Ventana de rate limit (1 min) |

### Regla #3 — Validación de .env al arrancar
`src/config.js` es lo primero que se importa en `bot.js`.
Si falta una variable de entorno, el proceso termina con mensaje claro **antes** de recibir cualquier request.

Al agregar una nueva integración que requiera credenciales obligatorias:
1. Agregar la variable a `REQUIRED_ENV` en `config.js`
2. Agregarla a `.env.example` con descripción

Variables opcionales (el bot funciona sin ellas): `TATUADOR_PHONE`, `PORT`.

### Regla #4 — Singletons para clientes externos
**Nunca instanciar `createClient()` ni `new Stripe()` directamente en routes o services.**
Siempre importar desde los singletons:

```js
// ✅ Correcto
const supabase = require('../services/supabase');
const stripe   = require('../services/stripe');

// ❌ Incorrecto
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(...); // crea una conexión extra innecesaria
```

### Regla #5 — Services sin estado de Express
Las funciones en `services/` reciben datos puros y devuelven datos puros.
No reciben `req`/`res` ni conocen de HTTP.

### Regla #6 — Manejo de errores por capa
- **Services**: lanzan (`throw`) errores, no los silencian
- **Routes**: capturan errores de services con try/catch y deciden la respuesta HTTP
- **Errores no críticos** (ej: Calendar falla pero el pago ya se confirmó): se loguean con `console.error` y se continúa — nunca bloquear el flujo principal por un error secundario

### Regla #7 — No sobrescribir datos existentes con null
Al hacer upserts en Supabase, construir el objeto dinámicamente:
```js
// ✅ Correcto
const data = { telefono: `+${telefono}` };
if (nombre) data.nombre = nombre;

// ❌ Incorrecto — puede borrar el nombre guardado
await supabase.from('clientes').upsert({ telefono, nombre }, ...);
```

### Regla #8 — Proceso gestionado por PM2
El bot corre bajo PM2, **no** con `node src/bot.js` ni `npm start` en producción.

```bash
pm2 start ecosystem.config.js --env production  # iniciar
pm2 reload tattoo-bot                            # reiniciar tras cambio de código
pm2 logs tattoo-bot                              # ver logs
```

### Regla #9 — Notificaciones por WhatsApp: siempre en bloque try/catch separado
Las notificaciones secundarias (al tatuador, confirmación al cliente) nunca deben bloquear el flujo principal si fallan:

```js
// ✅ Correcto
try {
  await notificarCliente(...);
} catch (err) {
  console.error('[WhatsApp] Error notificando:', err.message);
  // continúa — el pago ya fue confirmado
}
```

### Regla #10 — Convenciones de base de datos
- UUIDs para todos los IDs
- Timestamps en `TIMESTAMPTZ`
- Nombres de tablas, columnas y funciones en **español**
- Todas las tablas tienen RLS habilitado
- Triggers para `actualizado_en` automático en tablas que lo requieran

---

## Agregar una nueva feature — checklist

1. **¿Necesita credenciales obligatorias?** → Agregar a `REQUIRED_ENV` en `config.js` y a `.env.example`
2. **¿Tiene valores configurables?** → Agregar constante a `config.js`, no hardcodear
3. **¿Llama a una API externa?** → Crear o extender un archivo en `services/`
4. **¿Necesita Supabase o Stripe?** → Importar singleton de `services/supabase.js` o `services/stripe.js`
5. **¿Expone un endpoint HTTP?** → Crear o extender archivo en `routes/` y montarlo en `bot.js`
6. **¿Modifica la DB?** → Crear migration SQL en `supabase/` con nombre descriptivo
7. **¿Agrega una tool de Claude?** → Definir en `services/claude.js` junto a `TOOL_CREAR_PAGO`
8. **¿Envía notificación WA secundaria?** → Envolver en try/catch propio, nunca en el flujo principal

---

## Estado actual (2026-03-11)

### Servidor ✅
- Arquitectura modular: `config` → `services` → `routes` → `bot`
- Singletons: `services/supabase.js`, `services/stripe.js`
- Rate limiting por IP en `/webhook/whatsapp`
- Graceful shutdown con SIGTERM/SIGINT
- Health check real (ping a Supabase DB)
- PM2 v6.0.14 corriendo
- Iniciar: `pm2 start ecosystem.config.js --env production`

### WhatsApp ✅
- Timeout de 10s en todas las llamadas a la API de Meta
- Notificación automática al cliente cuando se confirma el pago
- Notificación automática al cliente cuando el link de pago expira
- Notificación al tatuador al recibir cita (requiere `TATUADOR_PHONE` en .env)
- Nombre del cliente: DB tiene prioridad sobre contact de WhatsApp
- Fallback si Claude devuelve respuesta vacía

### Claude ✅
- Reintentos automáticos con backoff exponencial (max 2 reintentos)
- Detección de primer mensaje → presentación como asistente IA
- Fecha/hora actual inyectada en el system prompt
- Respuestas cortas (max 3–4 líneas) para WhatsApp

### Base de datos — Supabase ✅
- Schema aplicado (`tattoo_schema.sql` + `migration_pagos.sql`)
- 8 tablas, 5 vistas, 4 ENUMs, funciones RPC
- Proyecto: `vftkpvcjmpgqxixabtwi`

### Meta / WhatsApp ✅
- WHATSAPP_PHONE_ID: `925813913959597`
- Webhook verificado apuntando a ngrok
- Número de prueba: +52 734 133 6392
- ⚠️ Pendiente: token permanente con System User (actual expira cada 24h)

### Google Calendar ✅
- Service account: `tattoo-bot@tattoo-bot-489404.iam.gserviceaccount.com`
- Credenciales: `C:\tattoo-bot\google-credentials.json`
- Calendar ID: `saasnegocio@gmail.com`

### Flujos n8n (importados, pendiente activar)
- `flujo_expirar_pagos.json`       — Schedule cada 2 min → `expirar_pagos_vencidos()`
- `flujo_confirmacion_stripe.json` — Webhook Stripe → `confirmar_pago_stripe()`

### Pendientes
- ⚠️ Configurar cuenta Stripe (MXN + métodos de pago) — checkout da error al abrir
- ⚠️ Token permanente WhatsApp (System User)
- ⚠️ Dominio fijo (ngrok cambia URL al reiniciar)
- ⚠️ Agregar `TATUADOR_PHONE` al .env para activar notificaciones al tatuador
- ⚠️ Validación de disponibilidad antes de crear cita (doble-booking)
- ⚠️ Activar flujos n8n (recordatorios y expiración de pagos)
