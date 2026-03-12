const Stripe = require('stripe');

// Singleton — una sola instancia compartida entre todos los módulos
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
