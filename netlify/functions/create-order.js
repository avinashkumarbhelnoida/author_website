// netlify/functions/create-order.js
//
// Called by the browser when the user clicks "BUY DIGITAL EDITION" on a book
// page, or "Pay" on the cart checkout page.
// The browser sends only book slug(s) + the user's Supabase access token.
// This function:
//   1. Verifies the user is actually logged in (validates the JWT)
//   2. Looks up the REAL prices from the database (never trusts the client)
//   3. Refuses books already in the user's library (no double charging)
//   4. Asks Razorpay to create ONE order for the total
//   5. Records one 'created' purchase row per book, all on that order
//   6. Returns just enough info for Razorpay Checkout to open in the browser
//
// Body: { bookSlugs: ['invisible-threads', ...], currency: 'INR' | 'USD' }
//   (the older { bookSlug: 'invisible-threads' } form is still accepted)
//
// Required environment variables (set in Netlify -> Site settings -> Environment):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY           (public — used only to validate the user's JWT)
//   SUPABASE_SERVICE_ROLE_KEY   (secret — used to write the purchase rows, bypassing RLS)
//   RAZORPAY_KEY_ID             (public — also returned to the frontend for Checkout)
//   RAZORPAY_KEY_SECRET         (secret — never leaves this function)

const { createClient } = require('@supabase/supabase-js');

const MAX_BOOKS_PER_ORDER = 20;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { bookSlugs, bookSlug, currency } = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Not logged in.' }) };
    }

    const slugs = [...new Set((Array.isArray(bookSlugs) ? bookSlugs : [bookSlug])
      .filter((s) => typeof s === 'string' && s))];
    if (!slugs.length || slugs.length > MAX_BOOKS_PER_ORDER) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please choose at least one book.' }) };
    }

    // 1. Validate the user's session
    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    const user = userData.user;

    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 2. Real prices from the database
    const { data: books, error: bookErr } = await serviceClient
      .from('books_catalog')
      .select('id, slug, title, subtitle, price_inr, price_usd, status')
      .in('slug', slugs);

    const forSale = (books || []).filter((b) => b.status === 'active');
    if (bookErr || forSale.length !== slugs.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'One or more books are not for sale.' }) };
    }

    // 3. Don't charge for books the reader already owns
    const { data: owned, error: ownedErr } = await serviceClient
      .from('library')
      .select('book_id')
      .eq('user_id', user.id)
      .eq('access_status', 'active')
      .in('book_id', forSale.map((b) => b.id));
    if (ownedErr) {
      console.error('Failed to check library:', ownedErr);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not start checkout. Please try again.' }) };
    }
    if (owned && owned.length) {
      const ownedIds = new Set(owned.map((o) => o.book_id));
      const titles = forSale.filter((b) => ownedIds.has(b.id)).map((b) => b.subtitle || b.title);
      return {
        statusCode: 409,
        body: JSON.stringify({ error: `Already in your library: ${titles.join(', ')}. Remove it from your cart to continue.` }),
      };
    }

    const useINR = (currency || 'INR').toUpperCase() !== 'USD';
    const currencyCode = useINR ? 'INR' : 'USD';
    const lines = forSale.map((b) => {
      const amount = Number(useINR ? b.price_inr : b.price_usd);
      return { book: b, amount, smallest: Math.round(amount * 100) };
    });
    const amountInSmallestUnit = lines.reduce((sum, l) => sum + l.smallest, 0);

    // 4. Create the Razorpay order (server-to-server, using the secret)
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
        notes: { user_id: user.id, book_slugs: slugs.join(',').slice(0, 250) },
      }),
    });

    if (!rpRes.ok) {
      const errText = await rpRes.text();
      console.error('Razorpay order creation failed:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not start checkout. Please try again.' }) };
    }

    const rpOrder = await rpRes.json();

    // 5. One 'created' purchase row per book, all tied to this order
    const { data: purchases, error: insertErr } = await serviceClient
      .from('purchases')
      .insert(lines.map((l) => ({
        user_id: user.id,
        book_id: l.book.id,
        razorpay_order_id: rpOrder.id,
        amount: l.amount,
        currency: currencyCode,
        payment_status: 'created',
      })))
      .select('id');

    if (insertErr) {
      console.error('Failed to record purchase:', insertErr);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not start checkout. Please try again.' }) };
    }

    const description = lines.length === 1
      ? [lines[0].book.title, lines[0].book.subtitle].filter(Boolean).join(' — ')
      : `${lines.length} Digital Editions`;

    // 6. Hand back only what Checkout needs
    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId: rpOrder.id,
        amount: amountInSmallestUnit,
        currency: currencyCode,
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        purchaseId: purchases[0].id,
        bookTitle: description,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong starting checkout.' }) };
  }
};
