-- ============================================================
-- TATTOO BOT — Esquema de Base de Datos
-- Supabase / PostgreSQL
-- ============================================================

-- ─────────────────────────────────────────
-- EXTENSIONES
-- ─────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ─────────────────────────────────────────
-- TABLA: clientes
-- Un registro por número de WhatsApp
-- ─────────────────────────────────────────
CREATE TABLE clientes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telefono      TEXT NOT NULL UNIQUE,         -- número WhatsApp (ej: +5215512345678)
  nombre        TEXT,
  primer_tatuaje BOOLEAN DEFAULT FALSE,
  notas         TEXT,                          -- notas internas del tatuador
  creado_en     TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE clientes IS 'Un registro por cliente identificado por su número de WhatsApp';
COMMENT ON COLUMN clientes.telefono IS 'Formato E.164: +52XXXXXXXXXX';


-- ─────────────────────────────────────────
-- TABLA: citas
-- Cada sesión agendada
-- ─────────────────────────────────────────
CREATE TYPE estado_cita AS ENUM (
  'pendiente',      -- bot recopiló info, esperando confirmación del cliente
  'confirmada',     -- cliente confirmó, slot bloqueado en calendario
  'recordatorio_enviado', -- recordatorio 24h enviado
  'completada',     -- sesión realizada
  'cancelada',      -- cancelada por cliente o tatuador
  'no_show'         -- cliente no se presentó
);

CREATE TABLE citas (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cliente_id        UUID NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,

  -- Fecha y duración
  fecha_hora        TIMESTAMPTZ NOT NULL,
  duracion_minutos  INTEGER DEFAULT 120,        -- estimado en base al tamaño

  -- Info del diseño
  diseno_estilo     TEXT,                       -- realismo, blackwork, etc.
  diseno_tamano     TEXT,                       -- pequeño / mediano / grande / manga
  diseno_zona       TEXT,                       -- antebrazo, espalda, etc.
  diseno_color      TEXT DEFAULT 'negro',       -- negro / color / ambos
  diseno_descripcion TEXT,                      -- texto libre del cliente
  imagen_referencia_url TEXT,                   -- foto enviada por WhatsApp

  -- Estado y seguimiento
  estado            estado_cita DEFAULT 'pendiente',
  precio_estimado   NUMERIC(10,2),              -- rango, no vinculante
  precio_final      NUMERIC(10,2),              -- llenado post-sesión
  google_event_id   TEXT,                       -- ID del evento en Google Calendar
  notas_tatuador    TEXT,                       -- notas internas

  -- Timestamps
  creado_en         TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en    TIMESTAMPTZ DEFAULT NOW(),
  confirmado_en     TIMESTAMPTZ,
  cancelado_en      TIMESTAMPTZ,
  razon_cancelacion TEXT
);

COMMENT ON TABLE citas IS 'Cada sesión de tatuaje agendada';
COMMENT ON COLUMN citas.google_event_id IS 'Referencia al evento en Google Calendar para sincronización';


-- ─────────────────────────────────────────
-- TABLA: conversaciones
-- Historial de mensajes WhatsApp por cliente
-- ─────────────────────────────────────────
CREATE TYPE rol_mensaje AS ENUM ('user', 'assistant', 'system');

CREATE TABLE conversaciones (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cliente_id    UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  cita_id       UUID REFERENCES citas(id) ON DELETE SET NULL,  -- cita relacionada si existe
  rol           rol_mensaje NOT NULL,
  contenido     TEXT NOT NULL,
  estado_bot    TEXT,                           -- S0, S1, S2... estado del flujo
  creado_en     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversaciones_cliente ON conversaciones(cliente_id);
CREATE INDEX idx_conversaciones_creado ON conversaciones(creado_en DESC);

COMMENT ON TABLE conversaciones IS 'Historial completo de mensajes para contexto de Claude';


-- ─────────────────────────────────────────
-- TABLA: disponibilidad_bloqueada
-- Slots que el tatuador cierra manualmente
-- ─────────────────────────────────────────
CREATE TABLE disponibilidad_bloqueada (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fecha_inicio TIMESTAMPTZ NOT NULL,
  fecha_fin    TIMESTAMPTZ NOT NULL,
  motivo       TEXT,                            -- vacaciones, enfermedad, etc.
  creado_en    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE disponibilidad_bloqueada IS 'Períodos bloqueados manualmente (vacaciones, días libres)';


-- ─────────────────────────────────────────
-- TABLA: configuracion_estudio
-- Parámetros del negocio
-- ─────────────────────────────────────────
CREATE TABLE configuracion_estudio (
  clave   TEXT PRIMARY KEY,
  valor   TEXT NOT NULL,
  descripcion TEXT
);

INSERT INTO configuracion_estudio (clave, valor, descripcion) VALUES
  ('nombre_estudio',       '[NOMBRE DEL ESTUDIO]',      'Nombre del estudio de tatuajes'),
  ('direccion',            '[DIRECCIÓN COMPLETA]',       'Dirección física del estudio'),
  ('telefono_directo',     '[NÚMERO WHATSAPP]',          'WhatsApp directo del tatuador'),
  ('horario_inicio',       '11:00',                      'Hora de apertura (HH:MM)'),
  ('horario_fin',          '20:00',                      'Hora de cierre (HH:MM)'),
  ('dias_laborales',       '2,3,4,5,6',                  'Días de semana: 0=Dom, 1=Lun... 6=Sab'),
  ('duracion_slot_min',    '60',                         'Duración mínima de slot en minutos'),
  ('anticipacion_min_hs',  '24',                         'Horas mínimas de anticipación para agendar'),
  ('cancelacion_min_hs',   '24',                         'Horas mínimas para cancelar sin penalización'),
  ('estilos_disponibles',  'Realismo,Blackwork,Tradicional,Geométrico,Minimalista,Chicano,Acuarela', 'Estilos que maneja el estudio'),
  ('recordatorio_hs',      '24',                         'Horas antes de la cita para enviar recordatorio'),
  ('mensaje_bienvenida',   '¡Hola! Bienvenido/a a {nombre_estudio} 🖤 Soy el asistente virtual y te ayudo a agendar tu cita.', 'Primer mensaje del bot');


-- ─────────────────────────────────────────
-- TABLA: recordatorios
-- Cola de mensajes programados
-- ─────────────────────────────────────────
CREATE TYPE estado_recordatorio AS ENUM ('pendiente', 'enviado', 'fallido', 'cancelado');

CREATE TABLE recordatorios (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cita_id         UUID NOT NULL REFERENCES citas(id) ON DELETE CASCADE,
  cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,               -- '24h_antes', 'post_cita', 'reactivacion'
  mensaje         TEXT NOT NULL,
  enviar_en       TIMESTAMPTZ NOT NULL,
  estado          estado_recordatorio DEFAULT 'pendiente',
  enviado_en      TIMESTAMPTZ,
  error_msg       TEXT,
  creado_en       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recordatorios_enviar ON recordatorios(enviar_en) WHERE estado = 'pendiente';

COMMENT ON TABLE recordatorios IS 'Cola de mensajes WhatsApp programados para envío futuro';


-- ─────────────────────────────────────────
-- TRIGGERS: actualizado_en automático
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_actualizado_en()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clientes_updated
  BEFORE UPDATE ON clientes
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();

CREATE TRIGGER trg_citas_updated
  BEFORE UPDATE ON citas
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();


-- ─────────────────────────────────────────
-- TRIGGER: crear recordatorio automático al confirmar cita
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION crear_recordatorio_cita()
RETURNS TRIGGER AS $$
DECLARE
  hs_antes INTEGER;
  cliente_tel TEXT;
  nombre_cli TEXT;
BEGIN
  -- Solo actuar cuando pasa a 'confirmada'
  IF NEW.estado = 'confirmada' AND OLD.estado != 'confirmada' THEN

    SELECT CAST(valor AS INTEGER) INTO hs_antes
    FROM configuracion_estudio WHERE clave = 'recordatorio_hs';

    SELECT telefono, nombre INTO cliente_tel, nombre_cli
    FROM clientes WHERE id = NEW.cliente_id;

    INSERT INTO recordatorios (cita_id, cliente_id, tipo, mensaje, enviar_en)
    VALUES (
      NEW.id,
      NEW.cliente_id,
      '24h_antes',
      '¡Hola ' || COALESCE(nombre_cli, 'ahí') || '! 👋 Te recuerdo que mañana tienes tu cita a las ' ||
        TO_CHAR(NEW.fecha_hora AT TIME ZONE 'America/Mexico_City', 'HH12:MI AM') || '. ¿Confirmas asistencia?',
      NEW.fecha_hora - (hs_antes || ' hours')::INTERVAL
    );

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recordatorio_al_confirmar
  AFTER UPDATE ON citas
  FOR EACH ROW EXECUTE FUNCTION crear_recordatorio_cita();


-- ─────────────────────────────────────────
-- VISTAS ÚTILES
-- ─────────────────────────────────────────

-- Vista: agenda del día / semana
CREATE VIEW v_agenda AS
SELECT
  c.id,
  c.fecha_hora,
  c.duracion_minutos,
  c.estado,
  c.diseno_estilo,
  c.diseno_tamano,
  c.diseno_zona,
  c.diseno_descripcion,
  c.imagen_referencia_url,
  c.precio_estimado,
  cl.nombre AS cliente_nombre,
  cl.telefono AS cliente_telefono,
  cl.primer_tatuaje
FROM citas c
JOIN clientes cl ON cl.id = c.cliente_id
WHERE c.estado NOT IN ('cancelada', 'no_show')
ORDER BY c.fecha_hora;

-- Vista: clientes activos con su última cita
CREATE VIEW v_clientes_resumen AS
SELECT
  cl.id,
  cl.nombre,
  cl.telefono,
  cl.creado_en,
  COUNT(c.id) AS total_citas,
  MAX(c.fecha_hora) AS ultima_cita,
  SUM(c.precio_final) AS valor_total
FROM clientes cl
LEFT JOIN citas c ON c.cliente_id = cl.id
GROUP BY cl.id, cl.nombre, cl.telefono, cl.creado_en;

-- Vista: recordatorios pendientes de envío
CREATE VIEW v_recordatorios_pendientes AS
SELECT
  r.id,
  r.tipo,
  r.mensaje,
  r.enviar_en,
  cl.telefono,
  cl.nombre AS cliente_nombre,
  c.fecha_hora AS fecha_cita
FROM recordatorios r
JOIN clientes cl ON cl.id = r.cliente_id
JOIN citas c ON c.id = r.cita_id
WHERE r.estado = 'pendiente'
  AND r.enviar_en <= NOW() + INTERVAL '5 minutes'
ORDER BY r.enviar_en;


-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────
ALTER TABLE clientes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE citas                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversaciones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE disponibilidad_bloqueada ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordatorios          ENABLE ROW LEVEL SECURITY;

-- Rol 'service_role' (backend/n8n) tiene acceso total
CREATE POLICY "service_full_access_clientes"
  ON clientes FOR ALL TO service_role USING (true);

CREATE POLICY "service_full_access_citas"
  ON citas FOR ALL TO service_role USING (true);

CREATE POLICY "service_full_access_conversaciones"
  ON conversaciones FOR ALL TO service_role USING (true);

CREATE POLICY "service_full_access_disponibilidad"
  ON disponibilidad_bloqueada FOR ALL TO service_role USING (true);

CREATE POLICY "service_full_access_recordatorios"
  ON recordatorios FOR ALL TO service_role USING (true);

-- Rol 'authenticated' (dashboard admin) puede leer y escribir todo
CREATE POLICY "admin_full_access_clientes"
  ON clientes FOR ALL TO authenticated USING (true);

CREATE POLICY "admin_full_access_citas"
  ON citas FOR ALL TO authenticated USING (true);

CREATE POLICY "admin_read_conversaciones"
  ON conversaciones FOR SELECT TO authenticated USING (true);

CREATE POLICY "admin_full_access_disponibilidad"
  ON disponibilidad_bloqueada FOR ALL TO authenticated USING (true);

CREATE POLICY "admin_read_recordatorios"
  ON recordatorios FOR SELECT TO authenticated USING (true);


-- ─────────────────────────────────────────
-- ÍNDICES DE PERFORMANCE
-- ─────────────────────────────────────────
CREATE INDEX idx_citas_fecha        ON citas(fecha_hora);
CREATE INDEX idx_citas_estado       ON citas(estado);
CREATE INDEX idx_citas_cliente      ON citas(cliente_id);
CREATE INDEX idx_clientes_telefono  ON clientes(telefono);

-- ─────────────────────────────────────────
-- FIN DEL ESQUEMA
-- ─────────────────────────────────────────
