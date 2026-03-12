const express  = require('express');
const supabase = require('../services/supabase');
const stripe   = require('../services/stripe');

const {
  SESSION_TIMEOUT_HORAS,
  MAX_HISTORIAL,
  ANTICIPO_PCT,
  STRIPE_EXPIRY_MIN,
  DEDUP_TTL_MS,
  MSG_MAX_AGE_MS,
} = require('../config');

const { normalizePhone, sendMessage, downloadMedia } = require('../services/whatsapp');
const { buildSystemPrompt, TOOL_CREAR_PAGO, callClaude } = require('../services/claude');

const router = express.Router();

// ─── Cola por usuario (evita race conditions) ─────────────────────────────────
const userQueues = new Map();
function enqueueForUser(phone, fn) {
  const prev = userQueues.get(phone) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  next.then(() => { if (userQueues.get(phone) === next) userQueues.delete(phone); });
  userQueues.set(phone, next);
  return next;
}

// ─── Deduplicación (Meta a veces reintenta envíos) ───────────────────────────
const processedMsgIds = new Map(); // msgId → timestamp
function isDuplicate(msgId) {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
  }
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.set(msgId, now);
  return false;
}

// ─── GET /webhook/whatsapp — verificación Meta ───────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WhatsApp] Webhook verificado por Meta.');
    return res.status(200).send(challenge);
  }

  console.warn('[WhatsApp] Verificación fallida — token incorrecto.');
  res.sendStatus(403);
});

// ─── POST /webhook/whatsapp — mensajes entrantes ─────────────────────────────
router.post('/', express.json(), async (req, res) => {
  res.sendStatus(200); // responder de inmediato para que Meta no reintente

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;

      const { messages = [], contacts = [] } = change.value;

      for (const msg of messages) {
        if (msg.type !== 'text' && msg.type !== 'image') continue;

        // Ignorar mensajes con más de 3 minutos de antigüedad
        // Evita procesar reintentos tardíos de Meta (ej: mensajes enviados cuando el servidor estaba caído)
        const msgAgeMs = Date.now() - Number(msg.timestamp) * 1000;
        if (msgAgeMs > MSG_MAX_AGE_MS) {
          console.log(`[WhatsApp] Mensaje obsoleto ignorado (${Math.round(msgAgeMs / 1000)}s de antigüedad): ${msg.id}`);
          continue;
        }

        if (isDuplicate(msg.id)) {
          console.log(`[WhatsApp] Duplicado ignorado: ${msg.id}`);
          continue;
        }

        const esImagen  = msg.type === 'image';
        const telefono  = normalizePhone(msg.from);
        const contenido = esImagen
          ? `[Imagen de referencia]${msg.image?.caption ? ': ' + msg.image.caption : ''}`
          : (msg.text?.body ?? '');
        const nombreWA  = contacts.find(c => c.wa_id === msg.from)?.profile?.name ?? null;

        console.log(`[WhatsApp] +${telefono} (${nombreWA ?? 'desconocido'}): ${contenido.slice(0, 80)}`);

        enqueueForUser(telefono, () =>
          procesarMensaje({ telefono, contenido, nombreWA, esImagen, msg })
        );
      }
    }
  }
});

// ─── Procesamiento principal de un mensaje ───────────────────────────────────
async function procesarMensaje({ telefono, contenido, nombreWA, esImagen, msg }) {
  try {
    // 1. Upsert cliente — nunca sobrescribir nombre existente con null
    //    Traer también el nombre guardado en DB para usarlo en el prompt
    const upsertData = { telefono: `+${telefono}` };
    if (nombreWA) upsertData.nombre = nombreWA;

    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .upsert(upsertData, { onConflict: 'telefono', ignoreDuplicates: false })
      .select('id, nombre')
      .single();
    if (clienteError) throw clienteError;

    // Nombre efectivo: DB tiene prioridad sobre el contact de WhatsApp
    const nombre = cliente.nombre ?? nombreWA;

    // 2. Guardar mensaje del usuario
    const { error: convError } = await supabase
      .from('conversaciones')
      .insert({ cliente_id: cliente.id, rol: 'user', contenido });
    if (convError) throw convError;

    // 3. Obtener historial y detectar nueva sesión por inactividad
    const { data: histDesc, error: histError } = await supabase
      .from('conversaciones')
      .select('rol, contenido, creado_en')
      .eq('cliente_id', cliente.id)
      .order('creado_en', { ascending: false })
      .limit(MAX_HISTORIAL);
    if (histError) throw histError;

    const historial = (histDesc ?? []).reverse();
    let historialEfectivo = historial;

    if (historial.length >= 2) {
      const penultimo = historial[historial.length - 2];
      const horasInactividad =
        (Date.now() - new Date(penultimo.creado_en).getTime()) / 3_600_000;
      if (horasInactividad >= SESSION_TIMEOUT_HORAS) {
        console.log(`[Session] Nueva sesión — ${horasInactividad.toFixed(1)}h de inactividad`);
        historialEfectivo = [historial[historial.length - 1]];
      }
    }

    // 4. Construir array de mensajes para Claude
    const claudeMessages = historialEfectivo
      .map(row => ({
        role:    row.rol === 'assistant' ? 'assistant' : 'user',
        content: row.contenido,
      }))
      .filter((m, i, arr) =>
        !(m.role === 'assistant' && arr[i + 1]?.role === 'assistant')
      );

    while (claudeMessages.length > 0 && claudeMessages[claudeMessages.length - 1].role === 'assistant') {
      claudeMessages.pop();
    }

    // 5. Inyectar imagen si el mensaje era una foto
    if (esImagen && msg.image?.id) {
      try {
        const { base64, mimeType } = await downloadMedia(msg.image.id);
        console.log('[WhatsApp] Imagen descargada — inyectando en Claude');
        claudeMessages[claudeMessages.length - 1] = {
          role:    'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text',  text: msg.image?.caption || 'El cliente envió esta imagen de referencia para su tatuaje.' },
          ],
        };
      } catch (imgErr) {
        console.error('[WhatsApp] Error descargando imagen:', imgErr.message);
      }
    }

    // 6. Llamar a Claude
    const esPrimerMensaje = historialEfectivo.length === 1;
    const systemPrompt    = buildSystemPrompt(nombre, esPrimerMensaje);
    const claudeResp      = await callClaude(claudeMessages, systemPrompt);

    // 7. Manejar tool use o respuesta directa
    let respuesta = '';
    if (claudeResp.stop_reason === 'tool_use') {
      const toolUse = claudeResp.content.find(b => b.type === 'tool_use');
      if (toolUse?.name === 'crear_link_pago') {
        respuesta = await ejecutarCrearLinkPago({
          toolUse, claudeResp, claudeMessages, systemPrompt, cliente,
        });
      }
    } else {
      respuesta = claudeResp.content.find(b => b.type === 'text')?.text ?? '';
    }

    // Fallback si Claude devuelve respuesta vacía
    if (!respuesta) {
      respuesta = 'Disculpa, tuve un problema al procesar tu mensaje. ¿Puedes intentarlo de nuevo?';
    }

    console.log(`[Claude] Respuesta para +${telefono}: ${respuesta.slice(0, 80)}...`);

    // 8. Guardar respuesta del bot
    const { error: botConvError } = await supabase
      .from('conversaciones')
      .insert({ cliente_id: cliente.id, rol: 'assistant', contenido: respuesta });
    if (botConvError) throw botConvError;

    // 9. Enviar por WhatsApp
    await sendMessage(telefono, respuesta);
    console.log(`[WhatsApp] ✅ Respuesta enviada a +${telefono}`);

  } catch (err) {
    console.error(`[WhatsApp] Error procesando +${telefono}:`, err.message);
  }
}

// ─── Tool: crear_link_pago ───────────────────────────────────────────────────
async function ejecutarCrearLinkPago({ toolUse, claudeResp, claudeMessages, systemPrompt, cliente }) {
  const input    = toolUse.input;
  const anticipo = Math.round(input.precio_estimado * ANTICIPO_PCT * 100) / 100;
  const expiryMs = STRIPE_EXPIRY_MIN * 60 * 1000;

  console.log('[Tool] crear_link_pago:', input);

  try {
    // a. Crear cita en Supabase
    const { data: cita, error: citaError } = await supabase
      .from('citas')
      .insert({
        cliente_id:         cliente.id,
        fecha_hora:         input.fecha_hora,
        diseno_estilo:      input.diseno_estilo      ?? null,
        diseno_tamano:      input.diseno_tamano,
        diseno_zona:        input.diseno_zona        ?? null,
        diseno_descripcion: input.diseno_descripcion ?? null,
        precio_estimado:    input.precio_estimado,
        estado:             'pendiente_pago',
      })
      .select('id')
      .single();
    if (citaError) throw citaError;

    // b. Crear Stripe Checkout — si falla, revertir la cita
    let stripeSession;
    try {
      stripeSession = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode:                 'payment',
        currency:             'mxn',
        line_items: [{
          price_data: {
            currency:     'mxn',
            unit_amount:  Math.round(anticipo * 100),
            product_data: {
              name:        `Anticipo tatuaje — ${input.diseno_tamano}`,
              description: input.diseno_descripcion
                ?? `${input.diseno_estilo ?? ''} ${input.diseno_zona ?? ''}`.trim(),
            },
          },
          quantity: 1,
        }],
        success_url: `${process.env.BASE_URL}/pago-exitoso`,
        cancel_url:  `${process.env.BASE_URL}/pago-cancelado`,
        expires_at:  Math.floor(Date.now() / 1000) + STRIPE_EXPIRY_MIN * 60,
        metadata:    { cita_id: cita.id, cliente_id: cliente.id },
      });
    } catch (stripeErr) {
      await supabase.from('citas').delete().eq('id', cita.id);
      throw stripeErr;
    }

    // c. Registrar pago en Supabase
    const { error: pagoError } = await supabase
      .from('pagos')
      .insert({
        cita_id:                    cita.id,
        cliente_id:                 cliente.id,
        monto_total_estimado:       input.precio_estimado,
        monto_anticipo:             anticipo,
        porcentaje_anticipo:        ANTICIPO_PCT * 100,
        stripe_checkout_session_id: stripeSession.id,
        stripe_payment_link_url:    stripeSession.url,
        estado:                     'pendiente',
        expira_en:                  new Date(Date.now() + expiryMs).toISOString(),
      });
    if (pagoError) throw pagoError;

    console.log(`[Tool] ✅ Cita ${cita.id} creada | link: ${stripeSession.url}`);

    // d. Segunda llamada a Claude con el resultado de la tool
    const messagesConTool = [
      ...claudeMessages,
      { role: 'assistant', content: claudeResp.content },
      {
        role:    'user',
        content: [{
          type:        'tool_result',
          tool_use_id: toolUse.id,
          content:     JSON.stringify({
            ok:                true,
            url:               stripeSession.url,
            anticipo,
            expira_en_minutos: STRIPE_EXPIRY_MIN,
          }),
        }],
      },
    ];

    const claudeResp2 = await callClaude(messagesConTool, systemPrompt);
    return claudeResp2.content.find(b => b.type === 'text')?.text
      || `¡Listo! Aquí está tu link de pago (válido ${STRIPE_EXPIRY_MIN} minutos):\n${stripeSession.url}\n\nAnticipo: $${anticipo} MXN (20% del total estimado).`;

  } catch (toolErr) {
    console.error('[Tool] Error en crear_link_pago:', toolErr.message);
    return 'Hubo un problema al generar el link de pago. Por favor intenta de nuevo en un momento.';
  }
}

module.exports = router;
