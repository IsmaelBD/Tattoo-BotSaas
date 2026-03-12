const { createClient } = require('@supabase/supabase-js');

// Singleton — una sola conexión compartida entre todos los módulos
const supabase = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_KEY.trim()
);

module.exports = supabase;
