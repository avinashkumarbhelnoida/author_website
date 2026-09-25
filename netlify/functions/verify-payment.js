// netlify/functions/verify-payment.js
//
// Called by the browser right after Razorpay Checkout closes with a
// "payment succeeded" response. The browser CANNOT be trusted to say
// "it worked" — this function independently verifies the cryptographic
// signature Razorpay attaches, and only THEN marks the purchase paid
// and grants library access.
//
// Required environment variables (same as create-order.js):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_SECRET

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      purchaseId,
    } = JSON.parse(event.body || '{}');

    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not logged in.' }) };
    }
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !purchaseId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment details.' }) };
    }

    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    const user = userData.user;

    // ---- THE ACTUAL SECURITY CHECK ----
    // Razorpay signs order_id + "|" + payment_id with your key secret (HMAC-SHA256).
    // If we recompute that signature ourselves and it doesn't match what the
    // browser sent, the payment claim is not trustworthy — reject it.
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Fetch the pending purchase row and confirm it actually belongs to this
    // user and this order — never trust purchaseId alone.
    const { data: purchase, error: fetchErr } = await serviceClient
      .from('purchases')
      .select('*')
      .eq('id', purchaseId)
      .eq('user_id', user.id)
      .eq('razorpay_order_id', razorpay_order_id)
      .single();

    if (fetchErr || !purchase) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Purchase record not found.' }) };
    }

    if (!isValid) {
      await serviceClient
        .from('purchases')
        .update({ payment_status: 'failed', razorpay_payment_id })
        .eq('id', purchaseId);
      return { statusCode: 400, body: JSON.stringify({ error: 'Payment verification failed.' }) };
    }

    // Signature is genuinely valid — mark paid.
    const { error: updateErr } = await serviceClient
      .from('purchases')
      .update({
        payment_status: 'paid',
        razorpay_payment_id,
        razorpay_signature,
      })
      .eq('id', purchaseId);

    if (updateErr) {
      console.error('Failed to update purchase:', updateErr);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Your payment was received. Your library is being updated. Please refresh or contact support if access does not appear.',
        }),
      };
    }

    // Grant library access (upsert — safe if this ever runs twice)
    const { error: libErr } = await serviceClient
      .from('library')
      .upsert(
        {
          user_id: user.id,
          book_id: purchase.book_id,
          purchase_id: purchase.id,
          access_status: 'active',
        },
        { onConflict: 'user_id,book_id' }
      );

    if (libErr) {
      console.error('Failed to grant library access:', libErr);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Your payment was received. Your library is being updated. Please refresh or contact support if access does not appear.',
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Your Digital Edition has been added to your library.' }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong verifying your payment.' }) };
  }
};
