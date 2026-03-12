const { GRAPH_API_VERSION } = require('../config');

const FETCH_TIMEOUT_MS = 10_000; // 10 segundos — evita que fetch bloquee la cola indefinidamente

// ─── fetch con timeout ────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Normalizar número de teléfono ────────────────────────────────────────────
// México móvil: wa_id llega como 521XXXXXXXXXX pero la API de envío necesita 52XXXXXXXXXX
function normalizePhone(waId) {
  return waId.startsWith('521') && waId.length === 13
    ? '52' + waId.slice(3)
    : waId;
}

// ─── Enviar mensaje de texto por WhatsApp ─────────────────────────────────────
async function sendMessage(telefono, texto) {
  const res = await fetchWithTimeout(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:                telefono,
        type:              'text',
        text:              { body: texto },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp API error: ${err}`);
  }

  return res.json();
}

// ─── Descargar media (imagen) de WhatsApp ─────────────────────────────────────
async function downloadMedia(mediaId) {
  const metaRes = await fetchWithTimeout(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
  if (!metaRes.ok) throw new Error(`Media meta error: ${metaRes.status}`);

  const { url, mime_type } = await metaRes.json();

  const imgRes = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  if (!imgRes.ok) throw new Error(`Media download error: ${imgRes.status}`);

  const buffer = await imgRes.arrayBuffer();
  return {
    base64:   Buffer.from(buffer).toString('base64'),
    mimeType: mime_type ?? 'image/jpeg',
  };
}

module.exports = { normalizePhone, sendMessage, downloadMedia };
