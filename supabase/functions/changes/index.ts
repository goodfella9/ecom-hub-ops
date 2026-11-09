// Approve or reject a staged change from the Hub. Approval runs it in Shopify.
import { admin, applyChange, CORS, json, requireAdmin } from "../_shared/hub.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await requireAdmin(req);
  if (who instanceof Response) return who;
  const { id, action } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !["approve", "reject"].includes(action)) return json({ error: "bad_request" }, 400);
  const actor = `hub:${who.email}`;
  if (action === "reject") {
    const { data } = await admin.from("pending_changes").update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: actor })
      .eq("id", id).eq("status", "pending").select("store_key,summary").maybeSingle();
    if (!data) return json({ ok: false, message: "Already handled." });
    await admin.from("audit_log").insert({ store_key: data.store_key, actor, action: "reject_change", summary: data.summary, status: "rejected", ref: id });
    return json({ ok: true, message: "Rejected." });
  }
  return json(await applyChange(id, actor));
});
