// Supabase Edge Function — mod-queue
// Deploy path: supabase/functions/mod-queue/index.ts
//
// Handles two things:
//   POST /mod-queue              { id, artist, pokemon, imageUrl, format } → sends moderation email
//   GET  /mod-queue?action=approve&id=X&token=Y  → approves submission
//   GET  /mod-queue?action=deny&id=X&token=Y     → deletes submission + image

const RESEND_API_KEY  = 're_QYPWfrRF_Bf5SYMNhbFscBaUofZUeQk7n';
const MOD_EMAIL       = 'cgc10magnezone@gmail.com';
const SUPABASE_URL    = 'https://uiypqbvrqbftfhqinkdc.supabase.co';
// Service role key — set this as an Edge Function secret called SUPABASE_SERVICE_KEY
// (never expose this in the frontend HTML)
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY');

// Simple HMAC-free token: sha256(id + secret) — good enough for moderation links
async function makeToken(id) {
  const secret = Deno.env.get('MOD_SECRET') || 'ppd-mod-secret-change-me';
  const data = new TextEncoder().encode(id + secret);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
}

async function sbAdmin(path, opts={}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers||{})
    }
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const FUNCTION_URL = url.origin + url.pathname;

  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }});
  }

  // ── GET: Approve or Deny ────────────────────────────────────
  if (req.method === 'GET') {
    const action = url.searchParams.get('action');
    const id     = url.searchParams.get('id');
    const token  = url.searchParams.get('token');

    if (!action || !id || !token) {
      return html(400, '❌ Missing parameters.');
    }

    const expected = await makeToken(id);
    if (token !== expected) {
      return html(403, '❌ Invalid or expired token.');
    }

    if (action === 'approve') {
      const r = await sbAdmin(
        `/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
          headers: { 'Prefer': 'return=minimal' } }
      );
      if (!r.ok) return html(500, '❌ Approval failed: ' + JSON.stringify(r.body));
      return html(200, '✅ Submission approved! It is now live on the site.');

    } else if (action === 'deny') {
      // 1. Fetch the row to get image path
      const fetch_r = await sbAdmin(`/rest/v1/submissions?id=eq.${encodeURIComponent(id)}&select=image_url`);
      if (fetch_r.ok && fetch_r.body?.length) {
        const imageUrl = fetch_r.body[0].image_url;
        // Extract storage path from URL
        const match = imageUrl.match(/\/card-art\/(.+)$/);
        if (match) {
          await sbAdmin(`/storage/v1/object/card-art/${match[1]}`, { method: 'DELETE' });
        }
      }
      // 2. Delete the DB row
      const r = await sbAdmin(
        `/rest/v1/submissions?id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
      );
      if (!r.ok) return html(500, '❌ Denial failed: ' + JSON.stringify(r.body));
      return html(200, '🗑️ Submission denied and deleted.');

    } else {
      return html(400, '❌ Unknown action.');
    }
  }

  // ── POST: Send moderation email ─────────────────────────────
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

    const { id, artist, pokemon, imageUrl, format, contact, description, aiUsed, aiTools } = body;
    if (!id || !artist || !imageUrl) {
      return new Response('Missing required fields', { status: 400 });
    }

    const token       = await makeToken(id);
    const approveUrl  = `${FUNCTION_URL}?action=approve&id=${encodeURIComponent(id)}&token=${token}`;
    const denyUrl     = `${FUNCTION_URL}?action=deny&id=${encodeURIComponent(id)}&token=${token}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: sans-serif; background: #0D0D1A; color: #F0F4FF; margin: 0; padding: 24px; }
  .card { background: #16213E; border-radius: 12px; padding: 24px; max-width: 560px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.08); }
  h2 { color: #F5C842; margin-top: 0; font-size: 1.4rem; }
  img { width: 100%; border-radius: 8px; margin: 16px 0; max-height: 300px; object-fit: contain; background: #1F2E4A; }
  .meta { font-size: 0.85rem; color: #8B9CC8; margin-bottom: 6px; }
  .meta strong { color: #F0F4FF; }
  .btn { display: inline-block; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 1rem; margin: 8px 8px 0 0; }
  .approve { background: #1D9E75; color: #fff; }
  .deny    { background: #E3350D; color: #fff; }
  .note { font-size: 0.75rem; color: #4A5A80; margin-top: 20px; }
</style></head>
<body>
<div class="card">
  <h2>🎨 New Card Art Submission</h2>
  <img src="${imageUrl}" alt="Card art by ${artist}">
  <div class="meta"><strong>Artist:</strong> ${artist}</div>
  <div class="meta"><strong>Pokémon / Subject:</strong> ${pokemon || '—'}</div>
  <div class="meta"><strong>Format:</strong> ${format || '—'}</div>
  <div class="meta"><strong>Contact:</strong> ${contact || '—'}</div>
  ${description ? `<div class="meta"><strong>Notes:</strong> ${description}</div>` : ''}
  ${aiUsed ? `<div class="meta"><strong>AI Tools Used:</strong> ${aiTools || 'Yes (unspecified)'}</div>` : ''}
  <br>
  <a class="btn approve" href="${approveUrl}">✅ Approve</a>
  <a class="btn deny"    href="${denyUrl}">🗑️ Deny</a>
  <p class="note">These links are single-use tokens. Do not forward this email.<br>Submission ID: ${id}</p>
</div>
</body>
</html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Project Pokedex <onboarding@resend.dev>',
        to:   MOD_EMAIL,
        subject: `[Review] New submission: ${pokemon || artist} by ${artist}`,
        html: emailHtml,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('Resend error:', err);
      return new Response('Email send failed: ' + err, { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response('Method not allowed', { status: 405 });
});

function html(status, message) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0D0D1A;color:#F0F4FF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
      <div style="text-align:center;font-size:1.3rem">${message}</div>
    </body></html>`,
    { status, headers: { 'Content-Type': 'text/html' } }
  );
}
