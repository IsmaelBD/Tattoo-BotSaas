-- ============================================================
-- TATTOO BOT — Migración: Tarifas + Pagos Stripe
-- Ejecutar DESPUÉS del schema base (tattoo_schema.sql)
-- ============================================================


-- ─────────────────────────────────────────
-- TABLA: tarifas
-- Catálogo de precios por tipo de tatuaje
-- ─────────────────────────────────────────
CREATE TABLE tarifas (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre            TEXT NOT NULL,            -- ej: "Mandala mediano"
  estilo            TEXT,                     -- blackwork, realismo, etc.
  tamano            TEXT,                     -- pequeño / mediano / grande / manga
  precio_base_min   NUMERIC(10,2) NOT NULL,   -- rango mínimo
  precio_base_max   NUMERIC(10,2) NOT NULL,   -- rango máximo
  duracion_estimada INTEGER DEFAULT 120,      -- minutos estimados
  porcentaje_anticipo NUMERIC(5,2) DEFAULT 20.00, -- % que se cobra al agendar
  activa            BOOLEAN DEFAULT TRUE,
  notas             TEXT,
  creado_en         TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE tarifas IS 'Catálogo de precios. El bot lo usa para calcular el anticipo automáticamente.';
COMMENT ON COLUMN tarifas.porcentaje_anticipo IS 'Porcentaje del precio_base_min que se cobra como anticipo vía Stripe';

-- Tarifas de ejemplo (ajustar a los precios reales del estudio)
INSERT INTO tarifas (nombre, estilo, tamano, precio_base_min, precio_base_max, duracion_estimada, porcentaje_anticipo) VALUES
  ('Diseño pequeño',         NULL,           'pequeño',  800,   1500,  60,  20),
  ('Diseño mediano',         NULL,           'mediano',  1500,  3000,  120, 20),
  ('Diseño grande',          NULL,           'grande',   3000,  6000,  240, 20),
  ('Manga completa',         NULL,           'manga',    8000,  15000, 480, 20),
  ('Blackwork pequeño',      'blackwork',    'pequeño',  900,   1800,  90,  20),
  ('Blackwork mediano',      'blackwork',    'mediano',  1800,  3500,  150, 20),
  ('Realismo mediano',       'realismo',     'mediano',  3000,  5000,  180, 20),
  ('Realismo grande',        'realismo',     'grande',   5000,  9000,  300, 20),
  ('Minimalista pequeño',    'minimalista',  'pequeño',  600,   1200,  45,  20),
  ('Geométrico mediano',     'geométrico',   'mediano',  2000,  3500,  120, 20),
  ('Consulta / boceto',      NULL,           NULL,       300,   300,   30,  100); -- anticipo = precio total


-- ─────────────────────────────────────────
-- TABLA: pagos
-- Cada intento/transacción de Stripe
-- ─────────────────────────────────────────
CREATE TYPE estado_pago AS ENUM (
  'pendiente',      -- link generado, esperando pago
  'pagado',         -- webhook de Stripe confirmó el pago
  'fallido',        -- pago rechazado
  'reembolsado',    -- se devolvió el dinero
  'expirado'        -- pasaron 20 min sin pagar
);

CREATE TABLE pagos (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cita_id               UUID NOT NULL REFERENCES citas(id) ON DELETE RESTRICT,
  cliente_id            UUID NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,

  -- Montos
  monto_total_estimado  NUMERIC(10,2) NOT NULL,   -- precio base de la tarifa
  monto_anticipo        NUMERIC(10,2) NOT NULL,   -- lo que se cobra ahora
  porcentaje_anticipo   NUMERIC(5,2)  NOT NULL,   -- % aplicado

  -- Stripe
  stripe_payment_intent_id  TEXT UNIQUE,          -- pi_xxxx
  stripe_checkout_session_id TEXT UNIQUE,         -- cs_xxxx
  stripe_payment_link_url   TEXT,                 -- link enviado al cliente
  stripe_charge_id          TEXT,                 -- ch_xxxx (post-pago)

  -- Estado y tiempos
  estado                estado_pago DEFAULT 'pendiente',
  expira_en             TIMESTAMPTZ NOT NULL,     -- NOW() + 20 min
  pagado_en             TIMESTAMPTZ,
  creado_en             TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pagos_cita        ON pagos(cita_id);
CREATE INDEX idx_pagos_estado      ON pagos(estado);
CREATE INDEX idx_pagos_expira      ON pagos(expira_en) WHERE estado = 'pendiente';
CREATE INDEX idx_pagos_stripe_pi   ON pagos(stripe_payment_intent_id);
CREATE INDEX idx_pagos_stripe_cs   ON pagos(stripe_checkout_session_id);

COMMENT ON TABLE pagos IS 'Cada transacción de anticipo. Un pago por cita (se puede reintentar si falla).';
COMMENT ON COLUMN pagos.expira_en IS 'Si no se paga antes de esta fecha, n8n cancela la cita automáticamente';


-- ─────────────────────────────────────────
-- TRIGGER: actualizado_en en pagos
-- ─────────────────────────────────────────
CREATE TRIGGER trg_pagos_updated
  BEFORE UPDATE ON pagos
  FOR EACH ROW EXECUTE FUNCTION set_actualizado_en();


-- ─────────────────────────────────────────
-- FUNCIÓN: calcular anticipo para una cita
-- Retorna monto_total y monto_anticipo
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION calcular_anticipo(
  p_estilo TEXT,
  p_tamano TEXT
)
RETURNS TABLE (
  tarifa_id         UUID,
  tarifa_nombre     TEXT,
  monto_total_min   NUMERIC,
  monto_total_max   NUMERIC,
  porcentaje        NUMERIC,
  monto_anticipo    NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.nombre,
    t.precio_base_min,
    t.precio_base_max,
    t.porcentaje_anticipo,
    ROUND(t.precio_base_min * t.porcentaje_anticipo / 100, 2)
  FROM tarifas t
  WHERE t.activa = TRUE
    AND (t.estilo IS NULL OR LOWER(t.estilo) = LOWER(p_estilo))
    AND (t.tamano IS NULL OR LOWER(t.tamano) = LOWER(p_tamano))
  ORDER BY
    -- priorizar coincidencia exacta en estilo
    CASE WHEN LOWER(t.estilo) = LOWER(p_estilo) THEN 0 ELSE 1 END,
    t.precio_base_min
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Ejemplo de uso:
-- SELECT * FROM calcular_anticipo('blackwork', 'mediano');
-- → tarifa: "Blackwork mediano", total: $1800–$3500, anticipo: $360


-- ─────────────────────────────────────────
-- FUNCIÓN: crear pago para una cita
-- Llamada desde n8n después de calcular anticipo
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION crear_pago_cita(
  p_cita_id           UUID,
  p_monto_total       NUMERIC,
  p_monto_anticipo    NUMERIC,
  p_porcentaje        NUMERIC,
  p_stripe_session_id TEXT,
  p_stripe_link_url   TEXT,
  p_minutos_expiracion INTEGER DEFAULT 20
)
RETURNS UUID AS $$
DECLARE
  v_cliente_id UUID;
  v_pago_id    UUID;
BEGIN
  SELECT cliente_id INTO v_cliente_id FROM citas WHERE id = p_cita_id;

  INSERT INTO pagos (
    cita_id, cliente_id,
    monto_total_estimado, monto_anticipo, porcentaje_anticipo,
    stripe_checkout_session_id, stripe_payment_link_url,
    expira_en
  ) VALUES (
    p_cita_id, v_cliente_id,
    p_monto_total, p_monto_anticipo, p_porcentaje,
    p_stripe_session_id, p_stripe_link_url,
    NOW() + (p_minutos_expiracion || ' minutes')::INTERVAL
  )
  RETURNING id INTO v_pago_id;

  -- Marcar la cita como 'pendiente_pago'
  UPDATE citas SET estado = 'pendiente_pago' WHERE id = p_cita_id;

  RETURN v_pago_id;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────
-- FUNCIÓN: confirmar pago (webhook de Stripe)
-- n8n la llama cuando llega checkout.session.completed
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION confirmar_pago_stripe(
  p_session_id  TEXT,
  p_charge_id   TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_pago   pagos%ROWTYPE;
  v_result JSONB;
BEGIN
  -- Buscar el pago por session ID
  SELECT * INTO v_pago FROM pagos WHERE stripe_checkout_session_id = p_session_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Pago no encontrado');
  END IF;

  IF v_pago.estado = 'pagado' THEN
    RETURN jsonb_build_object('ok', true, 'msg', 'Ya estaba confirmado');
  END IF;

  -- Marcar pago como pagado
  UPDATE pagos SET
    estado       = 'pagado',
    pagado_en    = NOW(),
    stripe_charge_id = p_charge_id
  WHERE id = v_pago.id;

  -- Confirmar la cita
  UPDATE citas SET
    estado       = 'confirmada',
    confirmado_en = NOW()
  WHERE id = v_pago.cita_id;

  RETURN jsonb_build_object(
    'ok',       true,
    'cita_id',  v_pago.cita_id,
    'pago_id',  v_pago.id,
    'monto',    v_pago.monto_anticipo
  );
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────
-- FUNCIÓN: expirar pagos vencidos
-- n8n la llama cada 2 minutos
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION expirar_pagos_vencidos()
RETURNS TABLE (cita_id UUID, cliente_id UUID, telefono TEXT) AS $$
BEGIN
  -- Marcar pagos como expirados
  UPDATE pagos SET estado = 'expirado'
  WHERE estado   = 'pendiente'
    AND expira_en < NOW();

  -- Cancelar las citas asociadas y retornar info para notificar al cliente
  RETURN QUERY
  UPDATE citas c
  SET
    estado            = 'cancelada',
    cancelado_en      = NOW(),
    razon_cancelacion = 'Anticipo no recibido en el tiempo límite'
  FROM pagos p
  WHERE p.cita_id      = c.id
    AND p.estado        = 'expirado'
    AND c.estado        = 'pendiente_pago'
  RETURNING c.id, c.cliente_id, cl.telefono
  FROM clientes cl WHERE cl.id = c.cliente_id;
END;
$$ LANGUAGE plpgsql;

-- Nota: la función anterior se simplifica mejor así para compatibilidad:
CREATE OR REPLACE FUNCTION expirar_pagos_vencidos()
RETURNS SETOF JSONB AS $$
DECLARE
  r RECORD;
BEGIN
  -- 1. Marcar pagos como expirados
  UPDATE pagos SET estado = 'expirado'
  WHERE estado = 'pendiente' AND expira_en < NOW();

  -- 2. Cancelar citas y devolver info para WhatsApp
  FOR r IN
    UPDATE citas c
    SET
      estado            = 'cancelada',
      cancelado_en      = NOW(),
      razon_cancelacion = 'Anticipo no recibido en el tiempo límite'
    FROM pagos p
    JOIN clientes cl ON cl.id = c.cliente_id
    WHERE p.cita_id  = c.id
      AND p.estado   = 'expirado'
      AND c.estado   = 'pendiente_pago'
    RETURNING c.id AS cita_id, cl.id AS cliente_id, cl.telefono, cl.nombre,
              c.fecha_hora, p.monto_anticipo, p.stripe_payment_link_url
  LOOP
    RETURN NEXT jsonb_build_object(
      'cita_id',    r.cita_id,
      'cliente_id', r.cliente_id,
      'telefono',   r.telefono,
      'nombre',     r.nombre,
      'fecha_hora', r.fecha_hora,
      'monto',      r.monto_anticipo,
      'link',       r.stripe_payment_link_url
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────
-- AGREGAR COLUMNA estado 'pendiente_pago' al ENUM
-- ─────────────────────────────────────────
ALTER TYPE estado_cita ADD VALUE IF NOT EXISTS 'pendiente_pago' AFTER 'pendiente';


-- ─────────────────────────────────────────
-- AGREGAR FK tarifa a citas
-- ─────────────────────────────────────────
ALTER TABLE citas ADD COLUMN IF NOT EXISTS tarifa_id UUID REFERENCES tarifas(id);
ALTER TABLE citas ADD COLUMN IF NOT EXISTS anticipo_requerido NUMERIC(10,2);


-- ─────────────────────────────────────────
-- VISTA: pagos pendientes por expirar
-- n8n la monitorea para enviar avisos urgentes
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW v_pagos_pendientes AS
SELECT
  p.id            AS pago_id,
  p.cita_id,
  p.monto_anticipo,
  p.stripe_payment_link_url,
  p.expira_en,
  EXTRACT(EPOCH FROM (p.expira_en - NOW())) / 60 AS minutos_restantes,
  cl.telefono,
  cl.nombre       AS cliente_nombre,
  c.fecha_hora    AS fecha_cita,
  c.diseno_estilo,
  c.diseno_tamano
FROM pagos p
JOIN citas    c  ON c.id  = p.cita_id
JOIN clientes cl ON cl.id = p.cliente_id
WHERE p.estado = 'pendiente'
ORDER BY p.expira_en ASC;


-- ─────────────────────────────────────────
-- VISTA: resumen financiero
-- Para el dashboard del tatuador
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW v_resumen_financiero AS
SELECT
  DATE_TRUNC('month', p.pagado_en)  AS mes,
  COUNT(*)                           AS total_anticipos,
  SUM(p.monto_anticipo)              AS total_cobrado,
  SUM(p.monto_total_estimado)        AS ingreso_estimado_total,
  AVG(p.monto_anticipo)              AS anticipo_promedio
FROM pagos p
WHERE p.estado = 'pagado'
GROUP BY 1
ORDER BY 1 DESC;


-- ─────────────────────────────────────────
-- CONFIGURACIÓN STRIPE (agregar a config)
-- ─────────────────────────────────────────
INSERT INTO configuracion_estudio (clave, valor, descripcion) VALUES
  ('stripe_currency',         'mxn',     'Moneda para Stripe (mxn, usd, etc.)'),
  ('anticipo_porcentaje',     '20',      'Porcentaje de anticipo por defecto'),
  ('pago_expiracion_minutos', '20',      'Minutos para expirar un pago sin completar'),
  ('stripe_success_url',      'https://[TU-DOMINIO]/pago/gracias', 'URL tras pago exitoso'),
  ('stripe_cancel_url',       'https://[TU-DOMINIO]/pago/cancelado', 'URL si el cliente cancela')
ON CONFLICT (clave) DO NOTHING;


-- ─────────────────────────────────────────
-- RLS para nuevas tablas
-- ─────────────────────────────────────────
ALTER TABLE tarifas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_access_tarifas" ON tarifas FOR ALL TO service_role USING (true);
CREATE POLICY "service_full_access_pagos"   ON pagos   FOR ALL TO service_role USING (true);
CREATE POLICY "admin_full_access_tarifas"   ON tarifas FOR ALL TO authenticated USING (true);
CREATE POLICY "admin_full_access_pagos"     ON pagos   FOR ALL TO authenticated USING (true);

-- ─────────────────────────────────────────
-- FIN DE MIGRACIÓN
-- ─────────────────────────────────────────
