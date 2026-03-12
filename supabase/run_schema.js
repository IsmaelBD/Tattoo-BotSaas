const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Leer .env manualmente
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.replace(/\r$/, '');
  const idx = trimmed.indexOf('=');
  if (idx > 0) {
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
}

// Usar DATABASE_URL directamente del .env
const connectionString = (env['DATABASE_URL'] || '').trim();
const hostMatch = connectionString.match(/@([^/]+)/);
const host = hostMatch ? hostMatch[1] : 'desconocido';

console.log(`Conectando a: ${host}`);

const sqlFile = path.join(__dirname, 'tattoo_schema.sql');
const sql = fs.readFileSync(sqlFile, 'utf8');

async function runSchema() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Conexión establecida.');

    await client.query(sql);
    console.log('\n✅ Schema ejecutado exitosamente.');
    console.log('\nTablas creadas:');
    const res = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);
    res.rows.forEach(r => console.log('  -', r.tablename));
  } catch (err) {
    console.error('\n❌ Error ejecutando schema:', err.message);
    if (err.detail) console.error('  Detalle:', err.detail);
    if (err.hint) console.error('  Hint:', err.hint);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runSchema();
