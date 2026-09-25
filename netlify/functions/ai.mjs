// Netlify Function: the only place the OpenAI key lives.
// The browser sends journal text here; this adds the secret key and calls OpenAI.
// Prompts and models are fixed here, so the endpoint can't be used as a general chatbot.

const QUICK_MODEL = process.env.QUICK_MODEL || "gpt-6-luna";
const DEEP_MODEL  = process.env.DEEP_MODEL  || "gpt-6-sol";
const MAX_ENTRY_CHARS = 8000;
const MAX_TOTAL_CHARS = 60000;
const MAX_ENTRIES = 200;
// Netlify kills functions after 60s (not configurable), so we keep well inside that.
const DEADLINE_MS = 25000; // only for starting a job, which should take a second or two
// Lower reasoning effort = much faster replies. Override with env vars if you want deeper thinking.
const QUICK_EFFORT = process.env.QUICK_EFFORT || "low";
const DEEP_EFFORT  = process.env.DEEP_EFFORT  || ""; // "" = the model's own default

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

const API = "https://api.openai.com/v1";

async function call(method, path, key, body, deadline){
  const ms = Math.max(1000, (deadline || Date.now() + 20000) - Date.now());
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try{
    const r = await fetch(API + path, { method, signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined });
    const b = await r.json().catch(() => null);
    return { r, b };
  }catch(e){
    if (ctl.signal.aborted) return { timeout: true };
    throw e;
  }finally{ clearTimeout(t); }
}

// Pull the text out of a finished Responses API object.
function outputText(body){
  let text = body?.output_text || "";
  if (!text) for (const item of body?.output || []) for (const c of item?.content || []) if (c?.type === "output_text") text += c.text;
  return text;
}

// Starts the job in OpenAI's "background mode": OpenAI returns an id at once and keeps working,
// so no single request to this site has to wait on Netlify's 60-second limit.
// store:true is needed for background mode; we delete the stored response as soon as it's collected.
async function startJob(model, instructions, input, key, effort, deadline){
  const base = { model, instructions, input, text: { format: { type: "json_object" } }, background: true, store: true };
  let res = await call("POST", "/responses", key, effort ? { ...base, reasoning: { effort } } : base, deadline);
  // Some models don't accept a reasoning setting; retry once without it (fails fast, so it's cheap).
  if (!res.timeout && res.r.status === 400 && effort && /reasoning|effort/i.test(res.b?.error?.message || ""))
    res = await call("POST", "/responses", key, base, deadline);
  return res;
}

const deleteJob = (id, key) => call("DELETE", `/responses/${id}`, key).catch(() => {});

function parseJSON(text){
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

const errorFor = (res) => {
  if (res.timeout) return json(504, { error: "The AI service didn't respond in time. Please try again." });
  console.error("OpenAI error", res.r.status, res.b?.error?.message);
  if (res.r.status === 429) return json(503, { error: "The AI is busy or the app's AI budget is used up. Please try again later." });
  // Include OpenAI's own reason (it never contains the key or journal text) so problems can be diagnosed.
  const why = String(res.b?.error?.message || "").slice(0, 300);
  return json(502, { error: `The AI service returned an error (${res.r.status}${why ? ": " + why : ""}).` });
};

export default async (req) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json(500, { error: "The app isn't set up yet: OPENAI_API_KEY is missing on the server." });
  const url = new URL(req.url);

  // --- Check on (GET) or cancel (DELETE) a job that's already running ---
  if (req.method === "GET" || req.method === "DELETE"){
    const id = url.searchParams.get("id") || "";
    if (!/^resp_[A-Za-z0-9_-]{8,100}$/.test(id)) return json(400, { error: "Bad request." });
    if (req.method === "DELETE"){
      await call("POST", `/responses/${id}/cancel`, key).catch(() => {});
      await deleteJob(id, key);
      return json(200, { ok: true });
    }
    try{
      const res = await call("GET", `/responses/${id}`, key, null, Date.now() + 20000);
      if (res.timeout || !res.r.ok) return errorFor(res);
      const body = res.b; const status = body?.status;
      if (status === "queued" || status === "in_progress") return json(200, { pending: true });
      await deleteJob(id, key); // collected (or failed): remove it from OpenAI's storage
      if (status === "incomplete") return json(502, { error: "The reply was cut short. Please try again." });
      if (status !== "completed"){
        console.error("OpenAI job ended as", status, body?.error?.message);
        return json(502, { error: "The AI couldn't finish this one. Please try again." });
      }
      const data = parseJSON(outputText(body));
      if (!data || typeof data !== "object" || Array.isArray(data)) return json(502, { error: "The reply came back in an unexpected format. Please try again." });
      return json(200, { data });
    }catch(e){
      console.error(e);
      return json(502, { error: "Couldn't reach the AI service. Please try again." });
    }
  }

  if (req.method !== "POST") return json(405, { error: "Use POST." });
  const deadline = Date.now() + DEADLINE_MS;

  let payload;
  try { payload = await req.json(); } catch { return json(400, { error: "Bad request." }); }

  let model, instructions, input, effort;
  if (payload?.kind === "quick"){
    const text = String(payload.text || "").trim();
    if (!text) return json(400, { error: "Empty entry." });
    model = QUICK_MODEL; instructions = QUICK_INSTR; effort = QUICK_EFFORT;
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
    model = DEEP_MODEL; instructions = DEEP_INSTR; effort = DEEP_EFFORT;
    input = `Journal entries, oldest first (${parts.length} of ${list.length}):\n\n${parts.join("\n\n---\n\n")}`;
  } else {
    return json(400, { error: "Unknown request." });
  }

  try{
    const eff = effort === "none" ? "" : effort;
    const res = await startJob(model, instructions, input, key, eff, deadline);
    if (!res.timeout && !res.r.ok && ![401, 429].includes(res.r.status)){
      // Background mode refused (model/account/project doesn't allow it): answer directly instead, within Netlify's limit.
      console.error("Background start failed, trying direct:", res.r.status, res.b?.error?.message);
      const base = { model, instructions, input, text: { format: { type: "json_object" } }, store: false };
      let d = await call("POST", "/responses", key, eff ? { ...base, reasoning: { effort: "low" } } : base, Date.now() + 50000);
      if (!d.timeout && d.r.status === 400 && /reasoning|effort/i.test(d.b?.error?.message || ""))
        d = await call("POST", "/responses", key, base, Date.now() + 45000);
      if (d.timeout) return json(504, { error: "The AI took too long to answer. Please try again." });
      if (!d.r.ok){
        const bgWhy = String(res.b?.error?.message || "").slice(0, 200);
        const r = errorFor(d); const b = await r.json();
        return json(r.status, { error: b.error + (bgWhy ? ` [background: ${bgWhy}]` : "") });
      }
      if (d.b?.status === "incomplete") return json(502, { error: "The reply was cut short. Please try again." });
      const data = parseJSON(outputText(d.b));
      if (!data || typeof data !== "object" || Array.isArray(data)) return json(502, { error: "The reply came back in an unexpected format. Please try again." });
      return json(200, { data });
    }
    if (res.timeout || !res.r.ok) return errorFor(res);
    const id = res.b?.id;
    if (!id) return json(502, { error: "The AI service returned an error. Please try again in a moment." });
    return json(202, { id });
  }catch(e){
    console.error(e);
    return json(502, { error: "Couldn't reach the AI service. Please try again." });
  }
};

export const config = { path: "/api/ai" };
