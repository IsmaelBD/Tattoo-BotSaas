// Configuración PM2 — gestor de procesos para producción
// Uso:
//   pm2 start ecosystem.config.js     ← iniciar
//   pm2 restart tattoo-bot            ← reiniciar
//   pm2 logs tattoo-bot               ← ver logs
//   pm2 save && pm2 startup           ← autoarranque al reiniciar el servidor

module.exports = {
  apps: [{
    name:         'tattoo-bot',
    script:       'src/bot.js',
    instances:    1,           // 1 instancia (el bot es stateful — colas en memoria)
    autorestart:  true,        // reiniciar si crashea
    watch:        false,       // no usar en producción
    max_memory_restart: '300M',
    env_production: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
