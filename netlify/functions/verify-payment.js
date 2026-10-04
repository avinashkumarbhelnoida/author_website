// netlify/functions/verify-payment.js
//
// Called by the browser right after Razorpay Checkout closes with a
// "payment succeeded" response. The browser CANNOT be trusted to say
// "it worked" — this function independently verifies the cryptographic
// signature Razorpay attaches, and only THEN marks the order's purchases
// paid and grants library access.
//
// If the buyer closes the tab before this runs, razorpay-webhook.js does the
// same job when Razorpay notifies the site directly.
//
// Required environment variables (same as create-order.js):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_SECRET

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getOrderPurchases, fulfillPurchases } = require('../lib/fulfill');

const RECEIVED_BUT_PENDING =
  'Your payment was received. Your library is being updated. Please refresh or contact support if access does not appear.';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = JSON.parse(event.body || '{}');

    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not logged in.' }) };
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment details.' }) };
    }

    // 1. Validate the user's session
    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    const user = userData.user;

    // 2. Verify Razorpay's signature: HMAC_SHA256(order_id|payment_id, key_secret)
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    const a = Buffer.from(expectedSignature);
    const b = Buffer.from(String(razorpay_signature));
    const isValid = a.length === b.length && crypto.timingSafeEqual(a, b);

    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 3. The order's purchase rows must belong to this user
    const purchases = await getOrderPurchases(serviceClient, razorpay_order_id, user.id);
    if (!purchases.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Purchase record not found.' }) };
    }

    if (!isValid) {
      await serviceClient
        .from('purchases')
        .update({ payment_status: 'failed', razorpay_payment_id })
        .in('id', purchases.filter((p) => p.payment_status === 'created').map((p) => p.id));
      return { statusCode: 400, body: JSON.stringify({ error: 'Payment verification failed.' }) };
    }

    // 4. Mark paid + grant library access (no-op if the webhook already did)
    try {
      await fulfillPurchases(serviceClient, purchases, {
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
      });
    } catch (fulfillErr) {
      console.error('Failed to fulfil order:', fulfillErr);
      return { statusCode: 500, body: JSON.stringify({ error: RECEIVED_BUT_PENDING }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: purchases.length === 1
          ? 'Your Digital Edition has been added to your library.'
          : 'Your Digital Editions have been added to your library.',
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong verifying your payment.' }) };
  }
};
