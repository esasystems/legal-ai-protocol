/* Cloudflare Pages Function: POST /api/analyze-protocol
   משתנים נדרשים ב-Cloudflare: Workers & Pages -> הפרויקט -> Settings -> Variables and Secrets (Production):
     GEMINI_API_KEY             (Secret)
     SUPABASE_URL               (Text)
     SUPABASE_SERVICE_ROLE_KEY  (Secret)
     GEMINI_MODEL               (אופציונלי, ברירת מחדל gemini-2.5-flash)
   אחרי הוספה או שינוי צריך deploy חדש. */

const FREE = 3;
const MIME_OK = /^(application\/pdf|audio\/(mp3|mpeg|wav|x-wav|mp4|x-m4a|m4a))$/;

const PROMPT = `אתה עוזר משפטי מומחה. נתח את החומר המצורף (פרוטוקול דיון, תמליל או הקלטת דיון) והחזר JSON בלבד, ללא טקסט נוסף וללא Markdown, בדיוק במבנה הבא:
{"timeline":[{"loc":"מיקום בחומר: עמוד ושורה בפרוטוקול, או חותמת זמן בהקלטה","speaker":"שם הדובר ותפקידו","event":"תיאור קצר של האירוע, הטענה או העדות","importance":"גבוהה | בינונית | נמוכה"}],"questions":[{"topic":"נושא השאלה","question":"שאלה לחקירה נגדית, מנוסחת לשימוש ישיר ומבוססת על תוכן החומר","goal":"מטרת השאלה"}]}
הנחיות: כתוב בעברית. סדר את האירועים בסדר כרונולוגי (8 עד 20 אירועים). הוסף 5 עד 12 שאלות לחקירה נגדית, עם דגש על סתירות, חוסרים ונקודות תורפה בעדויות. אל תמציא פרטים שאינם מופיעים בחומר. אם אין מיקום מדויק, כתוב "לא צוין".`;

const reply = (status, obj) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

export async function onRequestPost({ request, env }) {
  const SB = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
  const GK = env.GEMINI_API_KEY;
  const MODEL = env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!SB || !SRK || !GK) { console.error('Missing environment variables'); return reply(500, { code: 'CLOUD' }); }

  /* 1. אימות המשתמש לפי אסימון Supabase */
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return reply(401, { code: 'AUTH' });
  const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRK, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return reply(401, { code: 'AUTH' });
  const uid = (await ur.json().catch(() => ({}))).id;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) return reply(401, { code: 'AUTH' });

  const rest = (path, opt = {}) => fetch(`${SB}/rest/v1/${path}`, {
    ...opt,
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json', ...(opt.headers || {}) }
  });
  const readProfile = async () => {
    const r = await rest(`profiles?id=eq.${uid}&select=is_premium,usage_count`);
    if (!r.ok) throw new Error('profiles read ' + r.status);
    return (await r.json())[0];
  };

  /* 2. פרופיל, הרשאות ומכסה */
  let prof;
  try {
    prof = await readProfile();
    if (!prof) {
      await rest('profiles', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: JSON.stringify({ id: uid }) });
      prof = (await readProfile()) || { is_premium: false, usage_count: 0 };
    }
  } catch (e) { console.error(e); return reply(500, { code: 'CLOUD' }); }

  const premium = prof.is_premium === true;
  const count = prof.usage_count || 0;
  if (!premium && count >= FREE) return reply(403, { code: 'LIMIT' });

  /* 3. קלט */
  let b;
  try { b = await request.json(); } catch { return reply(400, { code: 'EMPTY' }); }
  let part;
  if (typeof b.protocolText === 'string' && b.protocolText.trim()) {
    part = { text: 'תוכן המסמך:\n' + b.protocolText.slice(0, 2000000) };
  } else if (b.filePart && b.filePart.inlineData && MIME_OK.test(b.filePart.inlineData.mimeType || '') && typeof b.filePart.inlineData.data === 'string') {
    part = { inlineData: { mimeType: b.filePart.inlineData.mimeType, data: b.filePart.inlineData.data } };
  } else return reply(400, { code: 'EMPTY' });

  /* 4. קריאה ל-Gemini */
  let text = '';
  try {
    const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GK },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [part, { text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });
    const j = await gr.json().catch(() => ({}));
    if (!gr.ok) {
      console.error('Gemini error', gr.status, j.error && j.error.message);
      return reply(gr.status === 429 ? 429 : 502, { code: gr.status === 429 ? 'RATE' : 'AI' });
    }
    text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(x => x.text || '').join('');
  } catch (e) { console.error(e); return reply(502, { code: 'AI' }); }
  if (!text.trim()) return reply(422, { code: 'EMPTY' });

  /* 5. עדכון המונה רק לאחר ניתוח מוצלח (ורק למשתמש שאינו פרימיום) */
  let newCount = count;
  if (!premium) {
    newCount = count + 1;
    try {
      const up = await rest(`profiles?id=eq.${uid}&usage_count=eq.${count}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ usage_count: newCount })
      });
      const rows = up.ok ? await up.json() : [];
      if (!rows.length) newCount = ((await readProfile()) || {}).usage_count ?? newCount;
    } catch (e) { console.error('usage update failed', e); }
  }
  return reply(200, { text, usage_count: newCount, is_premium: premium });
}

export async function onRequest() { return reply(405, { code: 'METHOD' }); }
