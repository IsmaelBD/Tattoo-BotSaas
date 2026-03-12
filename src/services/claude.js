const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_MODEL, STRIPE_EXPIRY_MIN } = require('../config');

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY.trim() });

const MAX_RETRIES    = 2;
const RETRY_DELAY_MS = 1000;

// ─── Definición de la tool (constante, no se recrea por request) ──────────────
const TOOL_CREAR_PAGO = {
  name: 'crear_link_pago',
  description: `Crea una cita y genera un link de pago de Stripe para que el cliente pague el anticipo del 20%. Usar cuando el cliente pida el link de pago o confirme que quiere agendar.`,
  input_schema: {
    type: 'object',
    properties: {
      fecha_hora:         { type: 'string', description: 'Fecha y hora de la cita en formato ISO 8601, ej: 2026-03-11T16:00:00-06:00' },
      diseno_estilo:      { type: 'string', description: 'Estilo del tatuaje' },
      diseno_tamano:      { type: 'string', description: 'Tamaño: pequeño, mediano, grande o manga' },
      diseno_zona:        { type: 'string', description: 'Zona del cuerpo' },
      diseno_descripcion: { type: 'string', description: 'Descripción del diseño' },
      precio_estimado:    { type: 'number', description: 'Precio estimado total en MXN' },
    },
    required: ['fecha_hora', 'diseno_tamano', 'precio_estimado'],
  },
};

// ─── System prompt ────────────────────────────────────────────────────────────
// esPrimerMensaje: true cuando es el primer contacto del cliente (o nueva sesión)
// → activa la presentación automática como asistente IA
function buildSystemPrompt(nombre, esPrimerMensaje = false) {
  const ahora         = new Date().toLocaleString('es-MX', { timeZone: 'America/Monterrey', hour12: false });
  const nombreCliente = nombre ?? null;

  return `Eres un asistente de inteligencia artificial del estudio de tatuajes. Tu misión es ayudar al cliente a agendar su cita de la forma más rápida y sencilla posible.

FECHA Y HORA ACTUAL: ${ahora} (zona horaria: America/Monterrey)
Usa este dato para validar fechas que pida el cliente y para saber si hoy el estudio está abierto.

CLIENTE:
${nombreCliente
    ? `- Nombre: ${nombreCliente}. Úsalo ocasionalmente para personalizar la conversación.`
    : `- Nombre: desconocido. Si no lo preguntas en la presentación, hazlo de forma natural en el momento oportuno.`
}

ESTUDIO:
- Horario: Martes a Sábado, 11:00–20:00 hrs (Domingo y Lunes cerrado)
- Estilos disponibles: Realismo, Blackwork, Tradicional, Geométrico, Minimalista, Chicano, Acuarela
- Tamaños: pequeño, mediano, grande, manga

PROCESO DE AGENDADO — recopila esta info de forma conversacional, un dato a la vez:
1. Estilo de tatuaje
2. Tamaño y zona del cuerpo
3. Descripción o imagen de referencia del diseño
4. Fecha y hora deseada (dentro del horario del estudio)

IMÁGENES DE REFERENCIA:
- Si el cliente manda una imagen, descríbela brevemente y confirma si es el estilo que busca
- Úsala para recomendar el estilo del catálogo más adecuado y seguir el flujo de agendado

TARIFAS APROXIMADAS:
- Pequeño: $800–$1,500 MXN | Mediano: $1,500–$3,000 MXN
- Grande: $3,000–$6,000 MXN | Manga: $8,000–$15,000 MXN
- Se requiere anticipo del 20% para confirmar la cita (se paga en línea con tarjeta)

ESCALACIÓN A HUMANO:
- Si el cliente tiene una queja, solicita hablar con alguien o tiene una pregunta muy específica que no puedes resolver, dile amablemente que puede contactar directamente al estudio y que un asesor le atenderá.

REGLAS DE RESPUESTA:
- Responde SIEMPRE en español de México, tono cálido y cercano — como si fuera una plática, no un formulario
- Mensajes CORTOS — máximo 3–4 líneas por respuesta. WhatsApp no es un correo.
- Haz solo UNA pregunta a la vez, nunca listes varias preguntas juntas
- Si el cliente pregunta el precio exacto, explica que depende del diseño final y ofrece el rango
- Cuando el cliente confirme que quiere agendar o pida el link de pago, usa la herramienta crear_link_pago con los datos recopilados. Usa el punto medio del rango como precio_estimado.
- Nunca inventes fechas, disponibilidad ni precios fuera del rango indicado

${esPrimerMensaje ? `INSTRUCCIÓN ESPECIAL — PRIMER MENSAJE:
Este es el primer mensaje del cliente. Preséntate brevemente como asistente de IA del estudio, menciona que le ayudarás a agendar su cita rápido y que puede preguntarte lo que sea. Luego arranca el flujo de agendado con la primera pregunta. Sé breve y amigable.` : ''}`.trim();
}

// ─── Llamada a Claude con reintentos automáticos ──────────────────────────────
// Si Anthropic regresa un error temporal (timeout, 529 overloaded), reintenta
// con backoff exponencial antes de fallar definitivamente.
async function callClaude(messages, systemPrompt) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await anthropic.messages.create({
        model:      CLAUDE_MODEL,
        max_tokens: 1024,
        system:     systemPrompt,
        tools:      [TOOL_CREAR_PAGO],
        messages,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[Claude] Error temporal (intento ${attempt + 1}/${MAX_RETRIES + 1}), reintentando en ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

module.exports = { TOOL_CREAR_PAGO, buildSystemPrompt, callClaude };
