// api/verify-iap.js
// Verifies Apple IAP receipt and grants subscription access in Supabase
// Deploy to: irontri/irontri-website

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Apple receipt verification URLs
const APPLE_VERIFY_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get user from auth header
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { receipt, productId } = req.body;
  if (!receipt) return res.status(400).json({ error: 'Missing receipt' });

  try {
    // Verify with Apple — try production first, fall back to sandbox
    let appleData = await verifyAppleReceipt(receipt, APPLE_VERIFY_URL);

    // Status 21007 means it's a sandbox receipt
    if (appleData.status === 21007) {
      appleData = await verifyAppleReceipt(receipt, APPLE_SANDBOX_URL);
    }

    if (appleData.status !== 0) {
      console.error('Apple verification failed, status:', appleData.status);
      return res.status(400).json({ error: 'Invalid receipt', appleStatus: appleData.status });
    }

    // Find the latest active subscription in the receipt
    const latestReceipts = appleData.latest_receipt_info || [];
    const activeReceipt = latestReceipts
      .filter(r => r.product_id === 'com.irontri.app.pro.monthly')
      .sort((a, b) => parseInt(b.expires_date_ms) - parseInt(a.expires_date_ms))[0];

    if (!activeReceipt) {
      return res.status(400).json({ error: 'No active subscription found in receipt' });
    }

    const expiresAt = new Date(parseInt(activeReceipt.expires_date_ms));
    const isActive = expiresAt > new Date();

    if (!isActive) {
      return res.status(400).json({ error: 'Subscription has expired' });
    }

    // Grant access in Supabase — update user metadata
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      user_metadata: {
        is_subscribed: true,
        subscription_source: 'apple_iap',
        apple_original_transaction_id: activeReceipt.original_transaction_id,
        apple_expires_at: expiresAt.toISOString(),
      }
    });

    if (updateError) {
      console.error('Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to update subscription status' });
    }

    // Also store in a subscriptions table if you have one
    // (optional but useful for reporting)
    await supabase.from('subscriptions').upsert({
      user_id: user.id,
      source: 'apple_iap',
      original_transaction_id: activeReceipt.original_transaction_id,
      product_id: activeReceipt.product_id,
      expires_at: expiresAt.toISOString(),
      is_active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'original_transaction_id' });

    return res.status(200).json({ success: true, expiresAt: expiresAt.toISOString() });

  } catch (e) {
    console.error('verify-iap error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function verifyAppleReceipt(receipt, url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receipt,
      'password': process.env.APPLE_SHARED_SECRET,
      'exclude-old-transactions': true,
    }),
  });
  return response.json();
}
