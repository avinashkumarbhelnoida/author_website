// netlify/lib/fulfill.js
//
// Shared by verify-payment.js (the browser reports a successful payment) and
// razorpay-webhook.js (Razorpay itself reports it, server-to-server).
// Whichever arrives first marks every purchase on the Razorpay order as paid
// and adds those books to the buyer's library; the second is a harmless no-op.
//
// Lives outside netlify/functions/ so Netlify doesn't deploy it as a function;
// esbuild bundles it into each function that requires it.

// Returns the purchase rows on an order (optionally limited to one user),
// skipping refunded ones so a replayed event can't restore a refunded book.
async function getOrderPurchases(serviceClient, orderId, userId) {
  let query = serviceClient
    .from('purchases')
    .select('id, user_id, book_id, amount, currency, payment_status')
    .eq('razorpay_order_id', orderId)
    .neq('payment_status', 'refunded');
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Marks the given purchases paid and grants library access for each book.
async function fulfillPurchases(serviceClient, purchases, { paymentId, signature }) {
  if (!purchases.length) return;

  const update = { payment_status: 'paid', razorpay_payment_id: paymentId };
  if (signature) update.razorpay_signature = signature;

  const { error: updateErr } = await serviceClient
    .from('purchases')
    .update(update)
    .in('id', purchases.map((p) => p.id));
  if (updateErr) throw updateErr;

  const { error: libErr } = await serviceClient
    .from('library')
    .upsert(
      purchases.map((p) => ({
        user_id: p.user_id,
        book_id: p.book_id,
        purchase_id: p.id,
        access_status: 'active',
      })),
      { onConflict: 'user_id,book_id' }
    );
  if (libErr) throw libErr;
}

module.exports = { getOrderPurchases, fulfillPurchases };
