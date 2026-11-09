// Checks each active store: can the Hub get a Shopify token and read the shop's name?
// Writes results to store_health. Returns only a count, never store data or keys.
import { createClient } from "npm:@supabase/supabase-js@2";

const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-10";
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return k.default ?? (Object.values(k)[0] as string); } catch { return ""; }
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

async function check(s: { key: string; shopify_domain: string }) {
  const p = `SHOP_${s.key.toUpperCase()}_`;
  const id = Deno.env.get(p + "CLIENT_ID"), secret = Deno.env.get(p + "CLIENT_SECRET");
  if (!id || !secret) return { ok: false, detail: "App keys not in the Hub's secrets yet" };
  const t = await fetch(`https://${s.shopify_domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const tt = await t.text();
  if (!t.ok) return { ok: false, detail: `Shopify refused the keys (HTTP ${t.status}): ${tt.slice(0, 200)}` };
  const tok = JSON.parse(tt);
  await admin.from("shopify_tokens").upsert({ store_key: s.key, access_token: tok.access_token, scope: tok.scope ?? "", expires_at: new Date(Date.now() + (Number(tok.expires_in) || 86399) * 1000).toISOString(), updated_at: new Date().toISOString() });
  const r = await fetch(`https://${s.shopify_domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": tok.access_token },
    body: JSON.stringify({ query: "{ shop { name } }" }),
  });
  const rt = await r.text();
  if (!r.ok) return { ok: false, detail: `Token worked but the API call failed (HTTP ${r.status}): ${rt.slice(0, 200)}`, scopes: (tok.scope ?? "").split(",").filter(Boolean) };
  const body = JSON.parse(rt);
  return { ok: !body.errors, shop_name: body?.data?.shop?.name ?? null, detail: body.errors ? JSON.stringify(body.errors).slice(0, 200) : "ok", scopes: (tok.scope ?? "").split(",").filter(Boolean) };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const { data: stores } = await admin.from("stores").select("key,shopify_domain").eq("active", true);
  for (const s of stores ?? []) {
    let res: any;
    try { res = await check(s); } catch (e) { res = { ok: false, detail: `Error: ${(e as Error).message}` }; }
    await admin.from("store_health").upsert({ store_key: s.key, ok: res.ok, shop_name: res.shop_name ?? null, scopes: res.scopes ?? [], detail: res.detail, checked_at: new Date().toISOString() });
  }
  return Response.json({ checked: (stores ?? []).length }, { headers: CORS });
});
