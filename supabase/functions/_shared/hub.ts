// Shared server code for Ecom Hub Ops edge functions.
import { createClient } from "npm:@supabase/supabase-js@2";

export const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-10";
export const TZ = "America/New_York";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return k.default ?? (Object.values(k)[0] as string);
  } catch {
    return "";
  }
}
export const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });

export class StoreError extends Error {}

export type Store = { key: string; name: string; shopify_domain: string; active: boolean; meta_account_id: string | null };

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
export const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

// Resolve the caller from their Supabase JWT and require app_admins membership.
export async function requireAdmin(req: Request): Promise<{ id: string; email: string } | Response> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in_required" }, 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return json({ error: "sign_in_required" }, 401);
  const { data: row } = await admin.from("app_admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!row) return json({ error: "forbidden" }, 403);
  return { id: data.user.id, email: data.user.email ?? "" };
}

export async function getStore(key: string): Promise<Store> {
  const { data } = await admin.from("stores").select("key,name,shopify_domain,active,meta_account_id").eq("key", key.trim().toLowerCase()).maybeSingle();
  if (!data) throw new StoreError(`Unknown store "${key}".`);
  if (!data.active) throw new StoreError(`${data.name} is switched off in the Hub.`);
  return data;
}

export async function shopToken(s: Store, force = false): Promise<string> {
  if (!force) {
    const { data } = await admin.from("shopify_tokens").select("access_token,expires_at").eq("store_key", s.key).maybeSingle();
    if (data && new Date(data.expires_at).getTime() - Date.now() > 5 * 60_000) return data.access_token;
  }
  const p = `SHOP_${s.key.toUpperCase()}_`;
  const id = Deno.env.get(p + "CLIENT_ID"), secret = Deno.env.get(p + "CLIENT_SECRET");
  if (!id || !secret) throw new StoreError(`${s.name} isn't connected: its Shopify app keys aren't in the Hub's secrets.`);
  const res = await fetch(`https://${s.shopify_domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const text = await res.text();
  if (!res.ok) throw new StoreError(`Couldn't reach ${s.name}: Shopify refused the app keys (HTTP ${res.status}).`);
  const body = JSON.parse(text);
  await admin.from("shopify_tokens").upsert({
    store_key: s.key, access_token: body.access_token, scope: body.scope ?? "",
    expires_at: new Date(Date.now() + (Number(body.expires_in) || 86399) * 1000).toISOString(), updated_at: new Date().toISOString(),
  });
  return body.access_token;
}

export async function shopGraphQL(s: Store, query: string, variables: Record<string, unknown> = {}) {
  const call = async (force: boolean) =>
    fetch(`https://${s.shopify_domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": await shopToken(s, force) },
      body: JSON.stringify({ query, variables }),
    });
  let res = await call(false);
  if (res.status === 401) res = await call(true);
  const text = await res.text();
  if (!res.ok) throw new StoreError(`Couldn't reach ${s.name} (HTTP ${res.status}).`);
  return JSON.parse(text);
}

// Run a staged change exactly once, log it, return the outcome.
export async function applyChange(changeId: string, actor: string) {
  const { data: c } = await admin.from("pending_changes")
    .update({ status: "applying", decided_at: new Date().toISOString(), decided_by: actor })
    .eq("id", changeId).eq("status", "pending").gt("created_at", new Date(Date.now() - 86_400_000).toISOString())
    .select("*").maybeSingle();
  if (!c) return { ok: false, message: "This change was already handled or has expired." };
  const s = await getStore(c.store_key);
  let body: any, status = "applied";
  try {
    body = await shopGraphQL(s, c.mutation, c.variables);
    if (body.errors || /"userErrors":\[(?!\])/.test(JSON.stringify(body))) status = "failed";
  } catch (e) {
    body = { error: (e as Error).message };
    status = "failed";
  }
  await admin.from("pending_changes").update({ status, result: body }).eq("id", changeId);
  await admin.from("audit_log").insert({ store_key: s.key, actor, action: "apply_change", summary: c.summary, status, ref: changeId });
  return { ok: status === "applied", message: status === "applied" ? `Done: ${c.summary}` : `Shopify rejected it: ${JSON.stringify(body).slice(0, 300)}` };
}

// Today's date (YYYY-MM-DD) and the UTC instant of local midnight, in the Hub's time zone.
export function localDay(offsetDays = 0): { date: string; startIso: string } {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const guess = new Date(`${parts}T00:00:00Z`);
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(guess).find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = tzName.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const sign = m?.[1] === "-" ? -1 : 1;
  const offMin = m ? sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -300;
  return { date: parts, startIso: new Date(guess.getTime() - offMin * 60_000).toISOString() };
}
