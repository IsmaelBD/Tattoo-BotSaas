const { google } = require('googleapis');
const { TIMEZONE } = require('../config');

const googleAuth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
  scopes:  ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth: googleAuth });

// ─── Crear evento en Google Calendar para una cita confirmada ─────────────────
async function createCitaEvent(cita) {
  const inicio = new Date(cita.fecha_hora);
  const fin    = new Date(inicio.getTime() + 2 * 60 * 60 * 1000); // duración estimada: 2h

  const titulo  = `Tatuaje — ${cita.diseno_tamano ?? ''} ${cita.diseno_estilo ?? ''}`.trim();
  const detalle = [
    cita.diseno_zona        && `Zona: ${cita.diseno_zona}`,
    cita.diseno_descripcion && `Diseño: ${cita.diseno_descripcion}`,
    cita.clientes?.telefono && `Tel: ${cita.clientes.telefono}`,
  ].filter(Boolean).join('\n');

  const gcEvent = await calendar.events.insert({
    calendarId:  process.env.GOOGLE_CALENDAR_ID,
    sendUpdates: 'all',
    requestBody: {
      summary:     titulo,
      description: detalle,
      start: { dateTime: inicio.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: fin.toISOString(),    timeZone: TIMEZONE },
    },
  });

  return gcEvent.data;
}

module.exports = { createCitaEvent };
