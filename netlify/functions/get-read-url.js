// netlify/functions/get-read-url.js
//
// Called by the Reader page when the user clicks "READ NOW". This is the
// ONLY path by which a book file's bytes can ever reach a browser.
// There is no public URL to the PDF anywhere in the frontend.
//
// Flow:
//   1. Validate the user's session
//   2. Check the `library` table for an ACTIVE row for this user + book
//   3. If (and only if) entitled, mint a short-lived Supabase Storage
//      signed URL (expires in 120 seconds) and return it
//   4. If not entitled, return 403 — the frontend shows
//      "This Digital Edition is not in your library."
//
// Required environment variables: same as the other two functions.

const { createClient } = require('@supabase/supabase-js');

const SIGNED_URL_EXPIRY_SECONDS = 120;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { bookSlug } = JSON.parse(event.body || '{}');
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const token = authHeader && authHeader.replace('Bearer ', '');

    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Your session has expired. Please sign in again.' }) };
    }
    if (!bookSlug) {
      return { statusCode: 400, body: JSON.stringify({ error: 'bookSlug is required.' }) };
    }

    const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Your session has expired. Please sign in again.' }) };
    }
    const user = userData.user;

    const serviceClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: book, error: bookErr } = await serviceClient
      .from('books_catalog')
      .select('id, title, subtitle, storage_path')
      .eq('slug', bookSlug)
      .single();

    if (bookErr || !book) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Book not found.' }) };
    }

    // ---- THE ENTITLEMENT CHECK ----
    const { data: entitlement, error: libErr } = await serviceClient
      .from('library')
      .select('access_status')
      .eq('user_id', user.id)
      .eq('book_id', book.id)
      .eq('access_status', 'active')
      .maybeSingle();

    if (libErr || !entitlement) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'This Digital Edition is not currently available in your library.' }),
      };
    }

    // Entitled — mint a short-lived signed URL to the private file.
    const { data: signed, error: signErr } = await serviceClient
      .storage
      .from('digital-books')
      .createSignedUrl(book.storage_path, SIGNED_URL_EXPIRY_SECONDS);

    if (signErr || !signed) {
      console.error('Failed to sign URL:', signErr);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not open the reader. Please try again.' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        url: signed.signedUrl,
        expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS,
        title: book.title,
        subtitle: book.subtitle,
        readerName: userData.user.user_metadata?.name || userData.user.email,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not open the reader. Please try again.' }) };
  }
};
