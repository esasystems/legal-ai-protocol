// filename=netlify/functions/analyze-protocol.mjs
import { createClient } from '@supabase/supabase-js';

export default async (req, context) => {
  // הגנת CORS מובנית - תמיכה בבקשות OPTIONS מראש
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    // 1. קריאת הנתונים מהבקשה בתחביר החדש
    const body = await req.json();
    const { protocolText, filePart } = body;
    let textToAnalyze = protocolText || '';

    if (filePart && filePart.inlineData) {
      textToAnalyze = "[קובץ מדיה/PDF מקודד נשלח לג'מיני]";
    }

    if (!textToAnalyze && !filePart) {
      return new Response(JSON.stringify({ error: 'לא התקבל טקסט או קובץ לניתוח' }), { status: 400, headers: corsHeaders });
    }

    // 2. אימות אסימון האבטחה (Token) של המשתמש
    const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'משתמש לא מחובר או חסר אסימון אבטחה' }), { status: 401, headers: corsHeaders });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!supabaseUrl || !supabaseServiceKey || !geminiApiKey) {
      return new Response(JSON.stringify({ error: 'שגיאת תשתית: מפתחות חסרים בשרת Netlify' }), { status: 500, headers: corsHeaders });
    }

    // יצירת חיבור מאובטח לסופאבייס
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    });

    // שליפת המשתמש מתוך השרת
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'אימות המשתמש נכשל' }), { status: 401, headers: corsHeaders });
    }

    // 3. בדיקת מכסת הניתוחים החינמיים
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('is_premium, usage_count')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'לא נמצא פרופיל משתמש תקין בבסיס הנתונים' }), { status: 500, headers: corsHeaders });
    }

    if (!profile.is_premium && profile.usage_count >= 3) {
      return new Response(JSON.stringify({ 
        error: 'LIMIT_REACHED', 
        message: 'הגעת למכסת הניתוחים החינמית שלך בגרסת הניסיון. אנא שדרג לפרימיום.' 
      }), { status: 403, headers: corsHeaders });
    }

    // 4. פנייה ל-API המעודכן של Google Gemini (Flash 1.5)
    const geminiUrl = `https://googleapis.com{geminiApiKey}`;
    const promptText = "אתה עוזר משפטי מומחה לניתוח פרוטוקולים, דיונים וחקירות נגדיות בבתי משפט בישראל. נתח את הטקסט הבא בצורה מקצועית וממצה בעברית. חלץ: 1. תקציר מנהלים מזוקק של הדיון. 2. סתירות, חוסר עקביות או נקודות תורפה בעדויות (הצלב נתונים וציין עמודים אם יש). 3. רשימת משימות המשך (Action Items) מומלצות לתיק לקראת הדיון הבא. הנה החומר לניתוח:\n\n" + textToAnalyze;

    const geminiBody = filePart ? {
      contents: [{ parts: [filePart, { text: promptText }] }]
    } : {
      contents: [{ parts: [{ text: promptText }] }]
    };

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      return new Response(JSON.stringify({ error: 'תקשורת מול גוגל ג\'מיני נכשלה', details: errText }), { status: 502, headers: corsHeaders });
    }

    const geminiData = await geminiResponse.json();
    const aiAnalysis = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiAnalysis) {
      return new Response(JSON.stringify({ error: 'התקבלה תשובה ריקה מה-AI' }), { status: 502, headers: corsHeaders });
    }

    // 5. עדכון מונה השימושים
    if (!profile.is_premium) {
      await supabase
        .from('profiles')
        .update({ usage_count: profile.usage_count + 1 })
        .eq('id', user.id);
    }

    // 6. החזרת התשובה בתחביר Response החדש
    return new Response(JSON.stringify({ analysis: aiAnalysis }), { status: 200, headers: corsHeaders });

  } catch (globalError) {
    return new Response(JSON.stringify({ error: 'שגיאת שרת פנימית בפונקציית הניתוח', details: globalError.message }), { status: 500, headers: corsHeaders });
  }
};
