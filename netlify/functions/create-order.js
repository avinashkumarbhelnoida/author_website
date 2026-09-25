// netlify/functions/create-order.js
//
// Called by the browser when the user clicks "BUY DIGITAL EDITION".
// The browser sends only a book slug + the user's Supabase access token.
// This function:
//   1. Verifies the user is actually logged in (validates the JWT)
//   2. Looks up the REAL price from the database (never trusts the client)
//   3. Asks Razorpay to create an order
//   4. Records a 'created' purchase row
//   5. Returns just enough info for Razorpay Checkout to open in the browser
//
// Required environment variables (set in Netlify -> Site settings -> Environment):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY           (public — used only to validate the user's JWT)
//   SUPABASE_SERVICE_ROLE_KEY   (secret — used to write the purchase row, bypassing RLS)
//   RAZORPAY_KEY_ID             (public — also returned to the frontend for Checkout)
//   RAZORPAY_KEY_SECRET         (secret — never leaves this function)

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { bookSlug, currency } = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not logged in.' }) };
    }
    if (!bookSlug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'bookSlug is required.' }) };
    }

    // 1. Validate the user's session using the ANON key (safe — this only
    //    checks "is this a real, current Supabase session", it can't write anything)
    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    const user = userData.user;

    // 2. Look up the REAL price server-side. The browser's opinion of the
    //    price is never used for anything.
    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: book, error: bookErr } = await serviceClient
      .from('books_catalog')
      .select('id, price_inr, price_usd, status')
      .eq('slug', bookSlug)
      .single();

    if (bookErr || !book || book.status !== 'active') {
      return { statusCode: 404, body: JSON.stringify({ error: 'Book not found or not for sale.' }) };
    }

    const useINR = (currency || 'INR').toUpperCase() !== 'USD';
    const amount = useINR ? book.price_inr : book.price_usd;
    const currencyCode = useINR ? 'INR' : 'USD';
    // Razorpay wants the amount in the smallest currency unit (paise / cents)
    const amountInSmallestUnit = Math.round(amount * 100);

    // 3. Ask Razorpay to create an order (server-to-server, Basic Auth with key:secret)
    const rpAuth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const rpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${rpAuth}`,
      },
      body: JSON.stringify({
        amount: amountInSmallestUnit,
        currency: currencyCode,
        notes: { book_id: book.id, user_id: user.id, book_slug: bookSlug },
      }),
    });

    if (!rpRes.ok) {
      const errText = await rpRes.text();
      console.error('Razorpay order creation failed:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not start checkout. Please try again.' }) };
    }
    const rpOrder = await rpRes.json();

    // 4. Record a 'created' purchase row (service_role — bypasses RLS by design;
    //    this is the ONE place allowed to write purchases on the user's behalf)
    const { data: purchase, error: insertErr } = await serviceClient
      .from('purchases')
      .insert({
        user_id: user.id,
        book_id: book.id,
        razorpay_order_id: rpOrder.id,
        amount,
        currency: currencyCode,
        payment_status: 'created',
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Failed to record purchase:', insertErr);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not start checkout. Please try again.' }) };
    }

    // 5. Return only what Razorpay Checkout needs in the browser.
    //    RAZORPAY_KEY_SECRET never leaves this function.
    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId: rpOrder.id,
        amount: amountInSmallestUnit,
        currency: currencyCode,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        purchaseId: purchase.id,
        bookTitle: 'THE MIND FILES — VOL-I: INVISIBLE THREADS',
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong starting checkout.' }) };
  }
};
