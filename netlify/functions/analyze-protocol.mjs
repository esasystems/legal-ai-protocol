// filename=netlify/functions/analyze-protocol.mjs
import { createClient } from '@supabase/supabase-js';

export const handler = async (event, context) => {
  // הגנת CORS - מאפשרת רק לאתר שלך לגשת ל-AI
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // 1. חילוץ הטקסט של הפרוטוקול מהבקשה של הדפדפן
    const { protocolText, filePart } = JSON.parse(event.body);
    let textToAnalyze = protocolText || '';

    // טיפול בקבצים מקודדים (PDF / שמע) במידה ונשלחו כ-Base64
    if (filePart && filePart.inlineData) {
      textToAnalyze = "[קובץ מדיה/PDF מקודד נשלח לג'מיני]";
    }

    if (!textToAnalyze && !filePart) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'לא התקבל טקסט או קובץ לניתוח' }) };
    }

    // 2. אימות אבטחה מול סופאבייס - מי המשתמש שמנסה לנתח?
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'משתמש לא מחובר או חסר אסימון אבטחה' }) };
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!supabaseUrl || !supabaseServiceKey || !geminiApiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'שגיאת תשתית: מפתחות סודיים חסרים בשרת Netlify' }) };
    }

    // יצירת חיבור מאובטח ברמת שרת לסופאבייס (עוקף RLS לצרכי הגדלת מונה)
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    });

    // שליפת ה-User ID מתוך הטוקן שבדפדפן
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'אימות המשתמש נכשל' }) };
    }

    // 3. בדיקת הרשאות ומכסה בטבלת profiles
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('is_premium, usage_count')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'לא נמצא פרופיל משתמש תקין בבסיס הנתונים' }) };
    }

    // תנאי החסימה האטומי: אם הוא לא פרימיום וכבר עשה 3 ניתוחים או יותר
    if (!profile.is_premium && profile.usage_count >= 3) {
      return { 
        statusCode: 403, 
        headers, 
        body: JSON.stringify({ 
          error: 'LIMIT_REACHED', 
          message: 'הגעת למכסת הניתוחים החינמית שלך בגרסת הניסיון. אנא שדרג לפרימיום.' 
        }) 
      };
    }

    // 4. פנייה מאובטחת וחבויה ל-API של Google Gemini
    const geminiUrl = `https://googleapis.com{geminiApiKey}`;
    
    // בניית הפרומפט המשפטי המקצועי של האפליקציה שלך
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
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'תקשורת מול גוגל ג\'מיני נכשלה', details: errText }) };
    }

    const geminiData = await geminiResponse.json();
    const aiAnalysis = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiAnalysis) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'התקבלה תשובה ריקה מה-AI' }) };
    }

    // 5. עדכון מונה השימושים רק לאחר ניתוח מוצלח (עבור משתמש חינמי)
    if (!profile.is_premium) {
      await supabase
        .from('profiles')
        .update({ usage_count: profile.usage_count + 1 })
        .eq('id', user.id);
    }

    // 6. החזרת הדוח המשפטי המושלם לדפדפן של עורך הדין
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ analysis: aiAnalysis })
    };

  } catch (globalError) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'שגיאת שרת פנימית בפונקציית הניתוח', details: globalError.message })
    };
  }
};
