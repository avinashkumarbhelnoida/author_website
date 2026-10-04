// netlify/functions/razorpay-webhook.js
//
// Razorpay calls this URL directly (server-to-server) when a payment
// succeeds. It is the safety net for buyers who pay and then close the tab
// before the browser can call verify-payment.js — without it, they would be
// charged but never get the book.
//
// Setup (Razorpay Dashboard -> Settings -> Webhooks -> Add New Webhook):
//   URL:    https://<your-site>/.netlify/functions/razorpay-webhook
//   Secret: any long random string; put the same value in Netlify as
//           RAZORPAY_WEBHOOK_SECRET
//   Events: payment.captured, order.paid
//
// Every request is authenticated by Razorpay's X-Razorpay-Signature header:
//   HMAC_SHA256(raw request body, RAZORPAY_WEBHOOK_SECRET)
// Anything without a valid signature is rejected.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_WEBHOOK_SECRET   (secret — never leaves this function)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getOrderPurchases, fulfillPurchases } = require('../lib/fulfill');

const HANDLED_EVENTS = new Set(['payment.captured', 'order.paid']);

function signatureIsValid(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  );
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // The signature covers the exact bytes Razorpay sent — don't re-serialise.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');
  const signature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'];

  if (!signatureIsValid(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature.' }) };
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf8'));
    if (!HANDLED_EVENTS.has(payload.event)) {
      return { statusCode: 200, body: JSON.stringify({ ignored: payload.event }) };
    }

    const payment = payload.payload?.payment?.entity;
    const orderId = payment?.order_id || payload.payload?.order?.entity?.id;
    if (!payment || !orderId) {
      return { statusCode: 200, body: JSON.stringify({ ignored: 'no payment/order in payload' }) };
    }

    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const purchases = await getOrderPurchases(serviceClient, orderId);
    if (!purchases.length) {
      // Not one of ours (e.g. a payment made outside the website).
      return { statusCode: 200, body: JSON.stringify({ ignored: 'unknown order' }) };
    }

    // The amount actually paid must match what we priced the order at.
    const expected = purchases.reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0);
    if (payment.amount !== expected || payment.currency !== purchases[0].currency) {
      console.error('Webhook amount mismatch for order', orderId, {
        paid: payment.amount, currency: payment.currency, expected,
      });
      return { statusCode: 200, body: JSON.stringify({ ignored: 'amount mismatch' }) };
    }

    // Idempotent: re-running for an already-paid order just re-confirms
    // library access (covers a verify-payment that failed halfway).
    await fulfillPurchases(serviceClient, purchases, { paymentId: payment.id });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    // A 5xx makes Razorpay retry later, which is what we want here.
    console.error('Webhook processing failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Processing failed.' }) };
  }
};
