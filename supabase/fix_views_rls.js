const https = require('https');
const fs = require('fs');

const envContent = fs.readFileSync(__dirname + '/../.env', 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.replace(/\r$/, '');
  const idx = trimmed.indexOf('=');
  if (idx > 0) env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

const pat = env.SUPABASE_PAT.trim();
const ref = 'vftkpvcjmpgqxixabtwi';

const sql = `
ALTER VIEW v_agenda                   SET (security_invoker = true);
ALTER VIEW v_clientes_resumen         SET (security_invoker = true);
ALTER VIEW v_pagos_pendientes         SET (security_invoker = true);
ALTER VIEW v_recordatorios_pendientes SET (security_invoker = true);
ALTER VIEW v_resumen_financiero       SET (security_invoker = true);
`;

async function runQuery(query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: '/v1/projects/' + ref + '/database/query',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + pat,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  const result = await runQuery(sql);
  if (result.status === 200 || result.status === 201) {
    console.log('✅ security_invoker = true aplicado a las 5 vistas.');

    // Verificar
    const check = await runQuery(
      "SELECT relname AS vista, reloptions FROM pg_class " +
      "JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace " +
      "WHERE nspname = 'public' AND relkind = 'v' ORDER BY relname"
    );
    const rows = JSON.parse(check.body);
    console.log('\nVerificación:');
    rows.forEach(r => {
      const opts = r.reloptions ? r.reloptions.join(', ') : 'sin opciones';
      console.log('  -', r.vista + ':', opts);
    });
  } else {
    console.log('❌ Status:', result.status);
    console.log(result.body);
  }
})();
