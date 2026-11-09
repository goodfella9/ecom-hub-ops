// Hub inbox actions for a signed-in admin: send (approve) a reply, save/discard a draft, file as done, reopen.
import { admin, CORS, json, requireAdmin } from "../_shared/hub.ts";
import { markDone, sendReply } from "../_shared/gmail.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await requireAdmin(req);
  if (who instanceof Response) return who;
  const actor = `hub:${who.email}`;
  const { action, ticket_id, body, note } = await req.json().catch(() => ({}));
  if (!ticket_id) return json({ error: "ticket_id required" }, 400);
  try {
    switch (action) {
      case "send": {
        const text = String(body ?? "").trim();
        if (text.length < 2) return json({ error: "The reply is empty." }, 400);
        return json({ ok: true, ...(await sendReply(ticket_id, text, actor)) });
      }
      case "save_draft":
        await admin.from("tickets").update({ draft_body: String(body ?? ""), draft_by: actor, draft_at: new Date().toISOString(), status: "awaiting_approval", updated_at: new Date().toISOString() }).eq("id", ticket_id);
        return json({ ok: true });
      case "discard_draft":
        await admin.from("tickets").update({ draft_body: null, draft_reason: null, status: "needs_you", updated_at: new Date().toISOString() }).eq("id", ticket_id);
        return json({ ok: true });
      case "note":
        await admin.from("tickets").update({ note: String(note ?? ""), updated_at: new Date().toISOString() }).eq("id", ticket_id);
        return json({ ok: true });
      case "done":
        await markDone(ticket_id, actor);
        return json({ ok: true });
      case "reopen":
        await admin.from("tickets").update({ status: "needs_you", updated_at: new Date().toISOString() }).eq("id", ticket_id);
        return json({ ok: true });
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
