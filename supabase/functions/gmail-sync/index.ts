// Pulls each store's support inbox into the Hub's tickets table.
// Runs every 5 minutes from pg_cron (header x-hub-cron must match hub_secrets.cron), or on demand by a signed-in admin.
// GET ?whoami=1 returns only the service account's public client ID (needed for domain-wide delegation).
import { admin, CORS, json, requireAdmin } from "../_shared/hub.ts";
import { findBlanks, markDone, saIdentity, sendReply, syncStore, syncThread } from "../_shared/gmail.ts";
import { runTicketActions } from "../_shared/actions.ts";

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
  // Internal actions (cron-secret only): used by Claude's inbox passes when the connector isn't loaded.
  if (cron && req.method === "POST") {
    const b = await req.clone().json().catch(() => ({}));
    if (b.action) {
      try {
        if (b.action === "reply") return json({ ok: true, ...(await sendReply(b.ticket_id, String(b.body), `claude:inbox-pass (${b.reason ?? "routine"})`)) });
        // Send a staged draft the way the Hub's Approve button does: chosen actions first, then the email.
        if (b.action === "send") {
          const text = String(b.body ?? "").trim();
          if (findBlanks(text).length) return json({ ok: false, error: "Draft still has blanks." }, 400);
          const actor = `claude:inbox-pass (${b.reason ?? "approved"})`;
          const done = await runTicketActions(b.ticket_id, Array.isArray(b.chosen) ? b.chosen.map(String) : [], actor);
          const sent = await sendReply(b.ticket_id, text, actor);
          await admin.from("tickets").update({ draft_actions: [] }).eq("id", b.ticket_id);
          if (b.file) await markDone(b.ticket_id, actor);
          return json({ ok: true, actions_done: done, ...sent });
        }
        if (b.action === "done") { await markDone(b.ticket_id, "claude:inbox-pass"); return json({ ok: true }); }
        if (b.action === "stage") {
          await admin.from("tickets").update({ draft_body: b.body, draft_reason: b.reason, draft_by: "claude:inbox-pass", draft_at: new Date().toISOString(), status: "awaiting_approval", updated_at: new Date().toISOString() }).eq("id", b.ticket_id);
          return json({ ok: true });
        }
        if (b.action === "flag") {
          await admin.from("tickets").update({ status: "needs_you", note: b.note, priority: b.priority ?? 2, updated_at: new Date().toISOString() }).eq("id", b.ticket_id);
          return json({ ok: true });
        }
        return json({ error: "unknown action" }, 400);
      } catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }
    }
  }
  const only = url.searchParams.get("store");
  // Bulk clean-up Brian asked for: file (Completed label + archive) every open ticket in one store whose last message is older than a date.
  const before = url.searchParams.get("archive_before");
  if (before && only) {
    const t0 = Date.now();
    const { data: old } = await admin.from("tickets").select("id").eq("store_key", only).neq("status", "done").lt("last_message_at", new Date(before).toISOString()).limit(400);
    let filed = 0, left = 0;
    for (const t of old ?? []) {
      if (Date.now() - t0 > 120_000) { left++; continue; }
      await markDone(t.id, "hub:bulk-archive (Brian: older than 30 days, handled by phone)");
      filed++;
    }
    return json({ store: only, filed, left });
  }
  // One-off after adding attachment support: re-read tickets' threads so older messages get their attachment lists.
  // ?backfill=1&store=x (open tickets) or &all=1 (filed ones too). Resumable: pass &after=<next_after> until done.
  if (url.searchParams.get("backfill") && only) {
    const t0 = Date.now();
    const after = Number(url.searchParams.get("after") ?? 0);
    const { data: s } = await admin.from("stores").select("support_email").eq("key", only).maybeSingle();
    let tq = admin.from("tickets").select("ticket_no,gmail_thread_id,in_spam").eq("store_key", only).gt("ticket_no", after).order("ticket_no").limit(500);
    if (!url.searchParams.get("all")) tq = tq.neq("status", "done");
    const { data: list } = await tq;
    let synced = 0, last = after;
    for (const t of list ?? []) {
      if (Date.now() - t0 > 110_000) return json({ store: only, synced, done: false, next_after: last });
      try { await syncThread(only, s!.support_email, t.gmail_thread_id, t.in_spam); synced++; }
      catch (e) { if (!/HTTP 404/.test((e as Error).message)) throw e; }
      last = t.ticket_no;
    }
    return json({ store: only, synced, done: (list ?? []).length < 500, next_after: last });
  }
  let q = admin.from("stores").select("key,support_email").eq("active", true).not("support_email", "is", null);
  if (only) q = q.eq("key", only);
  const { data: stores } = await q;
  const out: Record<string, unknown> = {};
  for (const s of stores ?? []) {
    try {
      const r = await syncStore(s.key, s.support_email, 4, only ? 120_000 : 40_000);
      await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: true, detail: `${r.checked} threads watched, ${r.updated} updated${r.pending ? `, ${r.pending} still loading` : ""}` });
      out[s.key] = { ok: true, ...r };
    } catch (e) {
      const msg = (e as Error).message;
      await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: false, detail: msg.slice(0, 500) });
      out[s.key] = { ok: false, error: msg };
    }
  }
  return json(out);
});
