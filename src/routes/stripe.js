const express  = require('express');
const supabase = require('../services/supabase');
const stripe   = require('../services/stripe');
const { createCitaEvent }       = require('../services/calendar');
const { sendMessage }           = require('../services/whatsapp');

const router = express.Router();

// ─── Helpers de mensajes ──────────────────────────────────────────────────────

function formatFecha(fechaISO) {
  return new Date(fechaISO).toLocaleString('es-MX', {
    timeZone: 'America/Monterrey',
    weekday:  'long',
    day:      'numeric',
    month:    'long',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   true,
  });
}

// Enviar notificación al cliente de confirmación de pago
async function notificarClientePagoConfirmado(telefono, cita, monto) {
  const fecha = formatFecha(cita.fecha_hora);
  const lineas = [
    `✅ ¡Tu cita está confirmada!`,
    ``,
    `📅 ${fecha}`,
    cita.diseno_tamano  && `🎨 ${cita.diseno_tamano}${cita.diseno_estilo ? ' · ' + cita.diseno_estilo : ''}`,
    cita.diseno_zona    && `📍 Zona: ${cita.diseno_zona}`,
    `💳 Anticipo pagado: $${monto} MXN`,
    ``,
    `Te esperamos. Cualquier cambio o duda, escríbenos aquí. 🖤`,
  ].filter(l => l !== false && l !== undefined);

  await sendMessage(telefono, lineas.join('\n'));
}

// Notificar al tatuador (si TATUADOR_PHONE está configurado)
async function notificarTatuadorCitaNueva(cita, monto) {
  if (!process.env.TATUADOR_PHONE) return;

  const fecha  = formatFecha(cita.fecha_hora);
  const lineas = [
    `🔔 Nueva cita confirmada`,
    ``,
    `👤 ${cita.clientes?.nombre ?? 'Sin nombre'} · +${cita.clientes?.telefono?.replace(/^\+/, '') ?? ''}`,
    `📅 ${fecha}`,
    cita.diseno_tamano      && `🎨 ${cita.diseno_tamano}${cita.diseno_estilo ? ' · ' + cita.diseno_estilo : ''}`,
    cita.diseno_zona        && `📍 ${cita.diseno_zona}`,
    cita.diseno_descripcion && `📝 ${cita.diseno_descripcion}`,
    `💰 Anticipo recibido: $${monto} MXN`,
  ].filter(l => l !== false && l !== undefined);

  await sendMessage(process.env.TATUADOR_PHONE, lineas.join('\n'));
}

// Notificar al cliente que el link de pago venció
async function notificarClienteLinkExpirado(telefono) {
  const msg = [
    `⏰ Tu link de pago venció y tu lugar fue liberado.`,
    ``,
    `Si todavía quieres agendar tu cita, responde aquí y te generamos un link nuevo en segundos. 😊`,
  ].join('\n');

  await sendMessage(telefono, msg);
}

// ─── POST /webhook/stripe ─────────────────────────────────────────────────────
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[Stripe] Firma inválida: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;
  console.log(`[Stripe] Evento: ${event.type} | session: ${session.id}`);

  try {
    switch (event.type) {

      // ── Pago completado ──────────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const { data, error } = await supabase.rpc('confirmar_pago_stripe', {
          p_session_id: session.id,
          p_charge_id:  session.payment_intent ?? null,
        });
        if (error) throw error;

        if (data?.ok) {
          console.log(`[Stripe] ✅ Pago confirmado — cita: ${data.cita_id} | monto: $${data.monto}`);

          // Obtener datos completos de la cita para notificaciones y Calendar
          const { data: cita } = await supabase
            .from('citas')
            .select('fecha_hora, diseno_estilo, diseno_tamano, diseno_zona, diseno_descripcion, clientes(nombre, telefono)')
            .eq('id', data.cita_id)
            .single();

          if (cita) {
            // Crear evento en Google Calendar
            try {
              const gcEvent = await createCitaEvent(cita);
              await supabase
                .from('citas')
                .update({ google_event_id: gcEvent.id })
                .eq('id', data.cita_id);
              console.log(`[Calendar] ✅ Evento creado: ${gcEvent.htmlLink}`);
            } catch (calErr) {
              console.error(`[Calendar] Error creando evento:`, calErr.message);
            }

            // Notificar al cliente por WhatsApp
            if (cita.clientes?.telefono) {
              try {
                const telCliente = cita.clientes.telefono.replace(/^\+/, '');
                await notificarClientePagoConfirmado(telCliente, cita, data.monto);
                console.log(`[WhatsApp] ✅ Confirmación enviada al cliente`);
              } catch (waErr) {
                console.error(`[WhatsApp] Error notificando cliente:`, waErr.message);
              }
            }

            // Notificar al tatuador por WhatsApp
            try {
              await notificarTatuadorCitaNueva(cita, data.monto);
              if (process.env.TATUADOR_PHONE) {
                console.log(`[WhatsApp] ✅ Notificación enviada al tatuador`);
              }
            } catch (waErr) {
              console.error(`[WhatsApp] Error notificando tatuador:`, waErr.message);
            }
          }

        } else {
          console.warn(`[Stripe] ⚠️  confirmar_pago_stripe respondió:`, data);
        }
        break;
      }

      // ── Sesión expirada (cliente no pagó a tiempo) ───────────────────────────
      case 'checkout.session.expired': {
        const { data: pago, error: fetchError } = await supabase
          .from('pagos')
          .select('id, cita_id, clientes(telefono)')
          .eq('stripe_checkout_session_id', session.id)
          .eq('estado', 'pendiente')
          .single();

        if (fetchError) {
          console.warn(`[Stripe] Pago no encontrado para session ${session.id}:`, fetchError.message);
          break;
        }

        const { error: pagoError } = await supabase
          .from('pagos')
          .update({ estado: 'expirado', actualizado_en: new Date().toISOString() })
          .eq('id', pago.id);
        if (pagoError) throw pagoError;

        const { error: citaError } = await supabase
          .from('citas')
          .update({
            estado:            'cancelada',
            cancelado_en:      new Date().toISOString(),
            razon_cancelacion: 'Anticipo no recibido en el tiempo límite',
          })
          .eq('id', pago.cita_id)
          .eq('estado', 'pendiente_pago');
        if (citaError) throw citaError;

        console.log(`[Stripe] ⏱️  Pago expirado — cita cancelada: ${pago.cita_id}`);

        // Notificar al cliente que el link venció
        if (pago.clientes?.telefono) {
          try {
            const telCliente = pago.clientes.telefono.replace(/^\+/, '');
            await notificarClienteLinkExpirado(telCliente);
            console.log(`[WhatsApp] ✅ Aviso de link expirado enviado al cliente`);
          } catch (waErr) {
            console.error(`[WhatsApp] Error notificando link expirado:`, waErr.message);
          }
        }

        break;
      }

      default:
        console.log(`[Stripe] Evento ignorado: ${event.type}`);
    }
  } catch (err) {
    console.error(`[Stripe] Error procesando ${event.type}:`, err.message);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
});

module.exports = router;
