// Streams one email attachment (photo, PDF...) from Gmail to a signed-in Hub admin.
// POST { message_id (ticket_messages.id), part_id } -> the file's bytes with its content type.
// Nothing is stored in the Hub: the file is read from the store's mailbox each time it's opened.
import { admin, CORS, json, requireAdmin } from "../_shared/hub.ts";
import { getAttachment } from "../_shared/gmail.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const who = await requireAdmin(req);
  if (who instanceof Response) return who;
  const { message_id, part_id } = await req.json().catch(() => ({}));
  if (!message_id || !part_id) return json({ error: "message_id and part_id required" }, 400);
  const { data: m } = await admin.from("ticket_messages")
    .select("gmail_message_id,attachments,tickets(stores(support_email))").eq("id", message_id).maybeSingle();
  if (!m) return json({ error: "No such message." }, 404);
  if (!((m.attachments ?? []) as { part_id: string }[]).some((a) => a.part_id === String(part_id))) return json({ error: "No such attachment on this message." }, 404);
  try {
    const mailbox = (m as any).tickets.stores.support_email as string;
    const a = await getAttachment(mailbox, m.gmail_message_id, String(part_id));
    const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
    // Only images and PDFs render inline; everything else downloads, so a hostile HTML/SVG file can't run in the Hub.
    const safeInline = /^image\/(png|jpe?g|gif|webp|heic|heif)$|^application\/pdf$/.test(a.mime);
    return new Response(bytes, {
      headers: {
        ...CORS,
        "content-type": safeInline ? a.mime : "application/octet-stream",
        "content-disposition": `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
