# ThoughtPattern

(Formerly "Inner Ledger". Browser storage keys still use the old `inner-ledger-*` names so existing data keeps working.)

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

## Optional: sign-in and encrypted sync (Supabase)
Sign-in is off until these are set. When set, users can sign in (Google or email link) and their
journal syncs across devices. Entries are encrypted on the device with the user's passphrase before
upload, so the server only stores ciphertext.
1. Create a free project at supabase.com. In SQL Editor, run `supabase/schema.sql`.
2. Authentication → URL Configuration: Site URL = `https://thoughtpattern.netlify.app`, and add it to Redirect URLs.
3. Authentication → Providers → Google: add a Google OAuth client ID/secret (Google Cloud Console →
   Credentials → OAuth client, type Web; authorised redirect URI = the callback URL Supabase shows).
4. Netlify → Environment variables: `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Supabase → Project Settings → API). Redeploy.
Email links use Supabase's built-in mailer, which only sends a few emails per hour; add custom SMTP
(e.g. Resend) under Authentication → Emails before a public launch.
