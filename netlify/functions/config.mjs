// Public settings the app needs to enable sign-in. The Supabase "anon" key is designed to be public;
// access is protected by row-level security in the database (see supabase/schema.sql).
export default async () => new Response(JSON.stringify({
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
}), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const config = { path: "/api/config" };
