/* Cloudflare Pages Function: POST /api/lead  (טופס רשימת ההמתנה לפרימיום)
   משתנים אופציונליים: RESEND_API_KEY (Secret), LEAD_TO_EMAIL */

const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return reply(400, { code: 'BAD' }); }
  if (b['bot-field']) return reply(200, { ok: true });

  const row = { name: clip(b.name, 120), phone: clip(b.phone, 30), email: clip(b.email, 160).toLowerCase(), plan: clip(b.plan, 120) };
  if (row.name.length < 2 || row.phone.replace(/\D/g, '').length < 9 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email)) return reply(400, { code: 'BAD' });

  const SB = (env.SUPABASE_URL || '').replace(/\/$/, '');
  let saved = false, mailed = false;

  if (SB && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const r = await fetch(`${SB}/rest/v1/premium_leads`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
      saved = r.ok;
      if (!r.ok) console.error('lead insert', r.status, await r.text());
    } catch (e) { console.error(e); }
  }

  if (env.RESEND_API_KEY && env.LEAD_TO_EMAIL) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Protocol-AI <onboarding@resend.dev>',
          to: [env.LEAD_TO_EMAIL],
          subject: 'ליד חדש לפרימיום: ' + row.name,
          html: `<div dir="rtl"><h3>ליד חדש מרשימת ההמתנה</h3><p>שם: ${esc(row.name)}<br>טלפון: ${esc(row.phone)}<br>אימייל: ${esc(row.email)}<br>מסלול: ${esc(row.plan)}</p></div>`
        })
      });
      mailed = r.ok;
      if (!r.ok) console.error('resend', r.status, await r.text());
    } catch (e) { console.error(e); }
  }

  return saved || mailed ? reply(200, { ok: true }) : reply(500, { code: 'CLOUD' });
}

export async function onRequest() { return reply(405, { code: 'METHOD' }); }
