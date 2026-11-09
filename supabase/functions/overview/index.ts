// Live overview for the Hub's home screen: sales today and last 7 days per store,
// Meta ad spend and return (via Windsor.ai), staged changes, and alerts.
import { admin, CORS, json, localDay, requireAdmin, shopGraphQL, type Store } from "../_shared/hub.ts";

const ORDERS = `query($q: String!, $after: String) {
  orders(first: 250, query: $q, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt cancelledAt test totalPriceSet { shopMoney { amount currencyCode } } }
  }
}`;

async function sales(s: Store, since7: string, sinceToday: string) {
  let after: string | null = null, pages = 0;
  const out = { today: { revenue: 0, orders: 0 }, last7: { revenue: 0, orders: 0 }, currency: "USD" };
  do {
    const body: any = await shopGraphQL(s, ORDERS, { q: `created_at:>='${since7}' -tag:proofhub-test`, after });
    if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 200));
    const conn = body.data.orders;
    for (const o of conn.nodes) {
      if (o.cancelledAt || o.test) continue;
      const amt = Number(o.totalPriceSet.shopMoney.amount);
      out.currency = o.totalPriceSet.shopMoney.currencyCode;
      out.last7.revenue += amt; out.last7.orders++;
      if (o.createdAt >= sinceToday) { out.today.revenue += amt; out.today.orders++; }
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && ++pages < 12);
  return out;
}

async function metaSpend(from: string, to: string, today: string) {
  const key = Deno.env.get("WINDSOR_API_KEY");
  if (!key) return { error: "Windsor API key not added yet" };
  const u = new URL("https://connectors.windsor.ai/facebook");
  u.searchParams.set("api_key", key);
  u.searchParams.set("date_from", from);
  u.searchParams.set("date_to", to);
  u.searchParams.set("fields", "account_id,date,spend,action_values_omni_purchase");
  const res = await fetch(u);
  if (!res.ok) return { error: `Windsor returned HTTP ${res.status}` };
  const body = await res.json();
  const rows: any[] = Array.isArray(body) ? body : body.data ?? [];
  const by: Record<string, { today: { spend: number; value: number }; last7: { spend: number; value: number } }> = {};
  for (const r of rows) {
    const a = String(r.account_id);
    by[a] ??= { today: { spend: 0, value: 0 }, last7: { spend: 0, value: 0 } };
    const sp = Number(r.spend) || 0, v = Number(r.action_values_omni_purchase) || 0;
    by[a].last7.spend += sp; by[a].last7.value += v;
    if (String(r.date).slice(0, 10) === today) { by[a].today.spend += sp; by[a].today.value += v; }
  }
  return { byAccount: by };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const who = await requireAdmin(req);
  if (who instanceof Response) return who;

  const today = localDay(0), start7 = localDay(-6);
  const { data: stores } = await admin.from("stores").select("key,name,shopify_domain,active,meta_account_id").eq("active", true).order("created_at");
  const [meta, pending, health] = await Promise.all([
    metaSpend(start7.date, today.date, today.date).catch((e) => ({ error: (e as Error).message })),
    admin.from("pending_changes").select("id,store_key,summary,created_at,source").eq("status", "pending")
      .gt("created_at", new Date(Date.now() - 86_400_000).toISOString()).order("created_at", { ascending: false }),
    admin.from("store_health").select("store_key,ok,detail,checked_at"),
  ]);

  const rows = await Promise.all((stores ?? []).map(async (s: Store) => {
    let sale: any = null, error: string | null = null;
    try { sale = await sales(s, start7.startIso, today.startIso); } catch (e) { error = `Couldn't reach ${s.name}: ${(e as Error).message}`; }
    const m = "byAccount" in meta && s.meta_account_id ? meta.byAccount[s.meta_account_id] ?? { today: { spend: 0, value: 0 }, last7: { spend: 0, value: 0 } } : null;
    return { key: s.key, name: s.name, sales: sale, meta: m, error };
  }));

  const alerts: { level: "red" | "gold"; store: string; title: string; detail: string }[] = [];
  for (const r of rows) {
    if (r.error) alerts.push({ level: "red", store: r.key, title: `${r.name} unreachable`, detail: r.error });
    if (r.meta && r.meta.last7.spend >= 50) {
      const roas = r.meta.last7.value / r.meta.last7.spend;
      if (roas < 1) alerts.push({ level: "red", store: r.key, title: `${r.name} Meta ads losing money`, detail: `Last 7 days: $${r.meta.last7.spend.toFixed(0)} spent, $${r.meta.last7.value.toFixed(0)} in Meta-credited sales (${roas.toFixed(2)}×).` });
      else if (roas < 1.5) alerts.push({ level: "gold", store: r.key, title: `${r.name} Meta return is thin`, detail: `Last 7 days: ${roas.toFixed(2)}× on $${r.meta.last7.spend.toFixed(0)}.` });
    }
  }
  if ("error" in meta) alerts.push({ level: "gold", store: "all", title: "Meta spend unavailable", detail: String(meta.error) });
  for (const p of pending.data ?? []) alerts.push({ level: "gold", store: p.store_key, title: "Change waiting for your approval", detail: p.summary });

  return json({
    generated_at: new Date().toISOString(),
    day: today.date,
    stores: rows,
    pending: pending.data ?? [],
    health: health.data ?? [],
    meta_error: "error" in meta ? meta.error : null,
    alerts,
  });
});
