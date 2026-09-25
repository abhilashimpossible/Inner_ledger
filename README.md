# Inner Ledger

A private journal web app. Users write entries; an AI reads across them and reflects back recurring
patterns through several psychological lenses (CBT thinking traps, schemas, defenses, attachment,
emotions and needs). It is a reflective tool, not a diagnosis.

## How it works
- `index.html` – the app. Entries are stored only in each user's browser (localStorage).
- `netlify/functions/ai.mjs` – server function at `/api/ai`. It holds the OpenAI key
  (`OPENAI_API_KEY` environment variable), runs two fixed prompts, and returns JSON.
  The key never reaches the browser.
- `manifest.webmanifest`, `sw.js`, icons – make it installable on phones and open offline.

## Deploy (Netlify)
1. Netlify → Add new project → Import an existing project → GitHub → this repo.
   Leave build command empty; publish directory `.` (read from `netlify.toml`).
2. Project configuration → Environment variables → add `OPENAI_API_KEY`.
3. Deploys → Trigger deploy. Every push to `main` redeploys automatically.

Optional env vars: `QUICK_MODEL` (default `gpt-6-luna`), `DEEP_MODEL` (default `gpt-6-sol`).
