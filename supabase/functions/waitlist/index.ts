// Public waitlist sign-up for the ecomhubops.com teaser page.
// Accepts only an email (+ optional store count). Never reveals whether an email was already on the list.
import { createClient } from "npm:@supabase/supabase-js@2";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return k.default ?? (Object.values(k)[0] as string); } catch { return ""; }
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

const ALLOWED = ["https://ecomhubops.com", "https://www.ecomhubops.com"];
const cors = (origin: string | null) => ({
  "access-control-allow-origin": origin && ALLOWED.includes(origin) ? origin : ALLOWED[1],
  "access-control-allow-headers": "content-type, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
  vary: "origin",
});

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: h });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: h });
  const body = await req.json().catch(() => ({}));
  const ok = () => Response.json({ ok: true }, { headers: h });
  if (body.company) return ok(); // honeypot: bots fill hidden fields
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) {
    return Response.json({ ok: false, error: "Please enter a valid email." }, { status: 400, headers: h });
  }
  const stores = ["1", "2-3", "4-10", "10+"].includes(body.stores) ? body.stores : null;
  const { error } = await admin.from("waitlist").insert({ email, stores, source: "teaser" });
  if (error && error.code !== "23505") { // 23505 = already on the list: treat as success
    console.error("waitlist insert", error.message);
    return Response.json({ ok: false, error: "Something went wrong. Try again in a minute." }, { status: 500, headers: h });
  }
  return ok();
});
