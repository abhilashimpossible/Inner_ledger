// Netlify Function: the only place the OpenAI key lives.
// The browser sends journal text here; this adds the secret key and calls OpenAI.
// Prompts and models are fixed here, so the endpoint can't be used as a general chatbot.

const QUICK_MODEL = process.env.QUICK_MODEL || "gpt-6-luna";
const DEEP_MODEL  = process.env.DEEP_MODEL  || "gpt-6-sol";
const MAX_ENTRY_CHARS = 8000;
const MAX_TOTAL_CHARS = 60000;
const MAX_ENTRIES = 200;

const QUICK_INSTR = `You are a reflective psychology assistant reading one private journal entry. Reply with ONLY a JSON object:
{"mood": "1-3 word emotional label", "valence": integer from -5 (very distressed) to 5 (very positive), "tags": [up to 3 short names of CBT cognitive distortions or psychodynamic defense mechanisms clearly present, or []], "note": "one gentle, specific sentence (max 20 words) naming the main dynamic you notice, addressed to the writer as 'you'"}
Do not diagnose.`;

const DEEP_INSTR = `You are an experienced, warm, psychodynamically and CBT-informed therapist reviewing a client's private journal. Analyse ALL the entries together to find recurring problems and patterns. Use these lenses: CBT cognitive distortions (Beck/Burns), schema therapy (Young's early maladaptive schemas), psychodynamic defense mechanisms, attachment theory, emotion analysis, and unmet needs (NVC / Maslow). Ground every claim in the writer's own words; quote short exact phrases as evidence. Frame insights as hypotheses, never as diagnoses; do not name psychiatric disorders. Address the writer as "you". Be specific, honest and kind; avoid generic advice.
If any entry suggests self-harm, suicidal thoughts, abuse or danger, set risk.flag true and write a caring one-sentence note.

Reply with ONLY this JSON object (arrays may be empty when nothing applies):
{
 "overview": "3-4 sentence synthesis of the central dynamic",
 "risk": {"flag": false, "note": ""},
 "patterns": [{"title": "short name, e.g. 'Criticism → shame → withdrawal'", "description": "1-2 sentences", "evidence": ["exact short quote"], "confidence": "low|medium|high"}],
 "distortions": [{"name": "e.g. Mind reading", "quote": "exact short quote", "reframe": "a balanced alternative thought or question"}],
 "coreBeliefs": [{"belief": "first-person belief", "schema": "Young schema name(s)", "origin_hypothesis": "tentative, 1 sentence"}],
 "defenses": [{"name": "e.g. Intellectualisation", "how_it_shows": "1 sentence"}],
 "attachment": {"style_leaning": "e.g. Anxious / Avoidant / Secure / Mixed, or 'Not enough information'", "notes": "1-2 sentences"},
 "emotions": [{"emotion": "name", "intensity": 0}],
 "needs": ["unmet need"],
 "strengths": ["specific strength visible in the entries"],
 "questions": ["reflective question tailored to them"],
 "exercises": [{"name": "exercise", "technique": "e.g. CBT / ACT / DBT / Schema / Mindfulness", "steps": ["concrete step"]}]
}
Emotion intensity is an integer 0-10. Give 2-5 patterns, up to 5 distortions, 1-3 core beliefs, up to 4 defenses, 3-7 emotions, 2-4 questions, 1-2 exercises.`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function callOpenAI(model, instructions, input, key){
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  let r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers,
    body: JSON.stringify({ model, instructions, input, text: { format: { type: "json_object" } }, store: false }) });
  let body = await r.json().catch(() => null);
  if (r.ok){
    let text = body?.output_text || "";
    if (!text) for (const item of body?.output || []) for (const c of item?.content || []) if (c?.type === "output_text") text += c.text;
    return { ok: true, text, incomplete: body?.status === "incomplete" };
  }
  if (r.status === 401 || r.status === 429) return { ok: false, status: r.status, message: body?.error?.message };
  // Fallback for models/accounts that only support Chat Completions
  r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "system", content: instructions }, { role: "user", content: input }], response_format: { type: "json_object" } }) });
  body = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, status: r.status, message: body?.error?.message };
  return { ok: true, text: body?.choices?.[0]?.message?.content || "", incomplete: body?.choices?.[0]?.finish_reason === "length" };
}

function parseJSON(text){
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(500, { error: "The app isn't set up yet: OPENAI_API_KEY is missing on the server." });

  let payload;
  try { payload = await req.json(); } catch { return json(400, { error: "Bad request." }); }

  let model, instructions, input;
  if (payload?.kind === "quick"){
    const text = String(payload.text || "").trim();
    if (!text) return json(400, { error: "Empty entry." });
    model = QUICK_MODEL; instructions = QUICK_INSTR;
    input = `Entry:\n"""${text.slice(0, MAX_ENTRY_CHARS)}"""`;
  } else if (payload?.kind === "deep"){
    const list = Array.isArray(payload.entries) ? payload.entries.slice(0, MAX_ENTRIES) : [];
    if (!list.length) return json(400, { error: "No entries to analyse." });
    let budget = MAX_TOTAL_CHARS; const parts = [];
    for (const e of list){ // newest first
      const s = `[${String(e?.date || "").slice(0, 16)}]\n${String(e?.text || "").slice(0, MAX_ENTRY_CHARS)}`;
      if (budget - s.length < 0) break; budget -= s.length; parts.push(s);
    }
    parts.reverse();
    model = DEEP_MODEL; instructions = DEEP_INSTR;
    input = `Journal entries, oldest first (${parts.length} of ${list.length}):\n\n${parts.join("\n\n---\n\n")}`;
  } else {
    return json(400, { error: "Unknown request." });
  }

  try{
    const r = await callOpenAI(model, instructions, input, key);
    if (!r.ok){
      console.error("OpenAI error", r.status, r.message);
      if (r.status === 429) return json(503, { error: "The AI is busy or the app's AI budget is used up. Please try again later." });
      return json(502, { error: "The AI service returned an error. Please try again in a moment." });
    }
    if (r.incomplete) return json(502, { error: "The reply was cut short. Please try again." });
    const data = parseJSON(r.text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return json(502, { error: "The reply came back in an unexpected format. Please try again." });
    return json(200, { data });
  }catch(e){
    console.error(e);
    return json(502, { error: "Couldn't reach the AI service. Please try again." });
  }
};

export const config = { path: "/api/ai" };
