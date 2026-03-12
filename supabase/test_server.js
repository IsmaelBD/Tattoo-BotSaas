// Script autónomo: arranca bot.js como proceso hijo y lo testea
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function request(options, body = null) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function waitForServer(port, retries = 10) {
  return new Promise((resolve, reject) => {
    const try_ = (n) => {
      http.get(`http://localhost:${port}/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else if (n > 0) setTimeout(() => try_(n - 1), 500);
        else reject(new Error('Server no responde'));
      }).on('error', () => {
        if (n > 0) setTimeout(() => try_(n - 1), 500);
        else reject(new Error('No se pudo conectar'));
      });
    };
    try_(retries);
  });
}

async function run() {
  // Iniciar el servidor como proceso hijo
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'bot.js')], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[error]  ' + d));

  try {
    await waitForServer(3000);
    console.log('\n--- Servidor listo. Iniciando tests ---\n');

    // 1. Health
    const h = await request({ host: 'localhost', port: 3000, path: '/health' });
    console.log(`/health                        HTTP ${h.status} ${h.status === 200 ? '✅' : '❌'}  ${h.body}`);

    // 2. GET verify - token correcto
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    const g1 = await request({
      host: 'localhost', port: 3000,
      path: `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=RETO_123`
    });
    const g1ok = g1.status === 200 && g1.body === 'RETO_123';
    console.log(`GET /webhook/whatsapp (válido)  HTTP ${g1.status} ${g1ok ? '✅' : '❌'}  body="${g1.body}"`);

    // 3. GET verify - token incorrecto
    const g2 = await request({
      host: 'localhost', port: 3000,
      path: '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X'
    });
    console.log(`GET /webhook/whatsapp (inválid) HTTP ${g2.status} ${g2.status === 403 ? '✅' : '❌'}`);

    // 4. POST mensaje
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        messages: [{ from: '5215512345678', id: 'wamid.t1', timestamp: '1772635000', type: 'text', text: { body: 'Hola, quiero info' } }],
        contacts: [{ wa_id: '5215512345678', profile: { name: 'Carlos Test' } }]
      }}]}]
    });
    const p = await request({
      host: 'localhost', port: 3000, path: '/webhook/whatsapp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, payload);
    console.log(`POST /webhook/whatsapp          HTTP ${p.status} ${p.status === 200 ? '✅' : '❌'}`);

    console.log('\n--- Tests completados ---');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}

run();
