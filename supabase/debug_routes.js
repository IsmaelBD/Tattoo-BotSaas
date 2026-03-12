require('dotenv').config();
const http = require('http');

async function get(port, path) {
  return new Promise(r => {
    http.get('http://localhost:' + port + path, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => r({ s: res.statusCode, b }));
    }).on('error', e => r({ s: 0, b: e.message }));
  });
}

(async () => {
  console.log('--- Cargando módulos paso a paso ---');

  const express = require('express');
  console.log('express v' + require('./node_modules/express/package.json').version + ' OK');

  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('stripe OK');

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_KEY.trim());
  console.log('supabase OK');

  const app = express();

  // Registrar rutas igual que en bot.js
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    res.json({ received: true });
  });
  console.log('route /webhook/stripe OK');

  app.get('/webhook/whatsapp', (req, res) => {
    res.status(200).send('CHALLENGE');
  });
  console.log('route GET /webhook/whatsapp OK');

  app.post('/webhook/whatsapp', express.json(), (req, res) => {
    res.sendStatus(200);
  });
  console.log('route POST /webhook/whatsapp OK');

  app.get('/health', (req, res) => res.json({ ok: true }));
  console.log('route /health OK');

  await new Promise(r => app.listen(3004, () => { console.log('Servidor en :3004'); r(); }));

  const h  = await get(3004, '/health');
  const g  = await get(3004, '/webhook/whatsapp?hub.verify_token=test');
  const s  = await get(3004, '/webhook/stripe');

  console.log('\nResultados:');
  console.log('GET /health            HTTP', h.s, h.s === 200 ? '✅' : '❌');
  console.log('GET /webhook/whatsapp  HTTP', g.s, g.s !== 404 ? '✅' : '❌ (404)');
  console.log('GET /webhook/stripe    HTTP', s.s, '(esperado 404 por ser GET)');

  process.exit(0);
})();
