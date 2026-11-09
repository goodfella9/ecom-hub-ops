// Pulls each store's support inbox into the Hub's tickets table.
// Runs every 5 minutes from pg_cron (header x-hub-cron must match hub_secrets.cron), or on demand by a signed-in admin.
// GET ?whoami=1 returns only the service account's public client ID (needed for domain-wide delegation).
import { admin, CORS, json, requireAdmin } from "../_shared/hub.ts";
import { saIdentity, syncStore } from "../_shared/gmail.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (url.searchParams.get("whoami")) {
    try { return json(saIdentity()); } catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  const cron = req.headers.get("x-hub-cron");
  if (cron) {
    const { data } = await admin.from("hub_secrets").select("value").eq("name", "cron").maybeSingle();
    if (!data || data.value !== cron) return json({ error: "forbidden" }, 403);
  } else {
    const who = await requireAdmin(req);
    if (who instanceof Response) return who;
  }
  const only = url.searchParams.get("store");
  let q = admin.from("stores").select("key,support_email").eq("active", true).not("support_email", "is", null);
  if (only) q = q.eq("key", only);
  const { data: stores } = await q;
  const out: Record<string, unknown> = {};
  for (const s of stores ?? []) {
    try {
      const n = await syncStore(s.key, s.support_email);
      await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: true, detail: `${n} threads checked` });
      out[s.key] = { ok: true, threads: n };
    } catch (e) {
      const msg = (e as Error).message;
      await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: false, detail: msg.slice(0, 500) });
      out[s.key] = { ok: false, error: msg };
    }
  }
  return json(out);
});
