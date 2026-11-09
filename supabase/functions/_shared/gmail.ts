// Gmail access for the Hub's support inboxes.
// A Google service account with Workspace domain-wide delegation impersonates each store's support mailbox.
// Key: Supabase secret GOOGLE_SA_KEY (the full service-account JSON). Scopes: gmail.modify + gmail.send.
import { admin } from "./hub.ts";

const SCOPES = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export class MailError extends Error {}

type SA = { client_email: string; client_id: string; private_key: string; token_uri?: string };
function sa(): SA {
  const raw = Deno.env.get("GOOGLE_SA_KEY");
  if (!raw) throw new MailError("The Google service-account key isn't in the Hub's secrets yet (GOOGLE_SA_KEY).");
  try { return JSON.parse(raw); } catch { throw new MailError("GOOGLE_SA_KEY isn't valid JSON. Paste the whole key file again."); }
}
export function saIdentity() {
  const k = sa();
  return { client_email: k.client_email, client_id: k.client_id };
}

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = ""; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

let keyCache: CryptoKey | null = null;
async function signingKey(pem: string) {
  if (keyCache) return keyCache;
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  keyCache = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return keyCache;
}

const memTokens = new Map<string, { token: string; exp: number }>();
export async function googleToken(mailbox: string): Promise<string> {
  const hit = memTokens.get(mailbox);
  if (hit && hit.exp - Date.now() > 120_000) return hit.token;
  const { data: row } = await admin.from("google_tokens").select("access_token,expires_at").eq("mailbox", mailbox).maybeSingle();
  if (row && new Date(row.expires_at).getTime() - Date.now() > 120_000) {
    memTokens.set(mailbox, { token: row.access_token, exp: new Date(row.expires_at).getTime() });
    return row.access_token;
  }
  const k = sa();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: k.client_email, sub: mailbox, scope: SCOPES, aud: k.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(k.private_key), new TextEncoder().encode(`${head}.${claims}`)));
  const res = await fetch(k.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(sig)}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new MailError(
      /unauthorized_client|not authorized/i.test(why)
        ? `Google hasn't authorized the Hub for ${mailbox} yet: add domain-wide delegation for client ID ${k.client_id} in that Workspace's admin console.`
        : `Google refused access to ${mailbox}: ${why}`,
    );
  }
  const exp = Date.now() + (Number(body.expires_in) || 3600) * 1000;
  memTokens.set(mailbox, { token: body.access_token, exp });
  await admin.from("google_tokens").upsert({ mailbox, access_token: body.access_token, expires_at: new Date(exp).toISOString() });
  return body.access_token;
}

export async function gmail(mailbox: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await googleToken(mailbox)}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new MailError(`Gmail error for ${mailbox} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---------- parsing ----------
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
const header = (p: Part, name: string) => p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
function findBody(p: Part, mime: string): string | null {
  if (p.mimeType === mime && p.body?.data) return fromB64url(p.body.data);
  for (const c of p.parts ?? []) { const r = findBody(c, mime); if (r) return r; }
  return null;
}
const stripHtml = (h: string) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
// Drop quoted history ("On ... wrote:") so each stored message is just what that person wrote.
const stripQuoted = (t: string) => t.split(/\n(?:On .{5,200}wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/)[0].replace(/(\n>.*)+\s*$/g, "").trim();
export const addr = (v: string) => (v.match(/<([^>]+)>/)?.[1] ?? v).trim().toLowerCase();
const nameOf = (v: string) => v.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() ?? null;

export function parseMessage(m: any) {
  const p: Part = m.payload ?? {};
  const html = findBody(p, "text/html");
  const raw = findBody(p, "text/plain") ?? (html ? stripHtml(html) : (m.snippet ?? ""));
  return {
    id: m.id as string,
    labels: (m.labelIds ?? []) as string[],
    from: header(p, "From"), to: header(p, "To"), subject: header(p, "Subject"),
    rfcId: header(p, "Message-ID") || header(p, "Message-Id"), references: header(p, "References"),
    sentAt: new Date(Number(m.internalDate)).toISOString(),
    body: stripQuoted(raw).slice(0, 20000),
    fullBody: raw,
  };
}

// Shopify contact forms arrive from mailer@shopify.com with the customer's address in the body.
function realCustomer(from: string, body: string) {
  const a = addr(from);
  if (a === "mailer@shopify.com" || a.endsWith("@shopify.com")) {
    const email = body.match(/E-?mail:?\s*\n?\s*([^\s<>]+@[^\s<>]+)/i)?.[1]?.toLowerCase();
    const name = body.match(/Name:?\s*\n?\s*([^\n]+)/i)?.[1]?.trim();
    if (email) return { email, name: name ?? null, via: "shopify_form" };
  }
  return { email: a, name: nameOf(from), via: a.endsWith("txt.voice.google.com") ? "sms" : "email" };
}

// System mail (store notifications, ad platforms, shipping software, no-reply senders) — never a customer.
const NOTICE_DOMAINS = /(^|\.)(shopifyemail\.com|shopify\.com|google\.com|googlemail\.com|shipstation\.com|shipengine\.com|microsoftadvertising\.com|facebookmail\.com|meta\.com|apple\.com|windsor\.ai|stripe\.com|paypal\.com|klaviyo\.com|amazon\.com|tiktok\.com|ups\.com|usps\.com|vercel\.com|supabase\.(io|com)|github\.com|intuit\.com|resend\.(dev|com))$/i;
export const isNotification = (email: string) => {
  const [local, domain = ""] = email.split("@");
  return NOTICE_DOMAINS.test(domain) || /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|alerts?|bounce)/i.test(local);
};

const ORDER_RE =/(?:order|#)\s*#?\s*(\d{4,6})\b/i;

// ---------- sync ----------
export async function completedLabel(store_key: string, mailbox: string): Promise<string> {
  const { data: st } = await admin.from("gmail_sync_state").select("completed_label_id").eq("store_key", store_key).maybeSingle();
  if (st?.completed_label_id) return st.completed_label_id;
  const { labels } = await gmail(mailbox, "/labels");
  let id = (labels ?? []).find((l: any) => l.name.toLowerCase() === "completed")?.id;
  if (!id) id = (await gmail(mailbox, "/labels", { method: "POST", body: JSON.stringify({ name: "Completed", labelListVisibility: "labelShow", messageListVisibility: "show" }) })).id;
  await admin.from("gmail_sync_state").upsert({ store_key, mailbox, completed_label_id: id });
  return id;
}

export async function syncThread(store_key: string, mailbox: string, threadId: string, inSpam = false) {
  const t = await gmail(mailbox, `/threads/${threadId}?format=full`);
  const msgs = (t.messages ?? []).map(parseMessage).filter((m: any) => !m.labels.includes("DRAFT"));
  if (!msgs.length) return null;
  // Anyone at the store's own domain (support@, brian@, ...) counts as staff, not the customer.
  const domain = mailbox.toLowerCase().split("@")[1];
  const mine = (m: any) => addr(m.from).split("@")[1] === domain;
  const firstIn = msgs.find((m: any) => !mine(m)) ?? msgs[0];
  const last = msgs[msgs.length - 1];
  const cust = realCustomer(firstIn.from, firstIn.fullBody);
  const lastFromCustomer = !mine(last);
  const unread = msgs.some((m: any) => m.labels.includes("UNREAD"));
  const inInbox = msgs.some((m: any) => m.labels.includes("INBOX"));
  const order = msgs.map((m: any) => `${m.subject}\n${m.body}`).join("\n").match(ORDER_RE)?.[1] ?? null;

  const { data: existing } = await admin.from("tickets").select("id,status,last_message_at").eq("store_key", store_key).eq("gmail_thread_id", threadId).maybeSingle();
  let status = existing?.status ?? "new";
  const newActivity = !existing || new Date(last.sentAt) > new Date(existing.last_message_at ?? 0);
  if (newActivity && lastFromCustomer && (status === "done" || status === "replied")) status = "new";
  if (!lastFromCustomer && status !== "done" && status !== "awaiting_approval") status = "replied";
  if (!inInbox && !inSpam && status !== "done" && !lastFromCustomer) status = "done";

  const notice = cust.via === "email" && isNotification(cust.email);
  const row = {
    store_key, gmail_thread_id: threadId, gmail_history_id: String(t.historyId ?? ""), subject: firstIn.subject || "(no subject)",
    customer_email: cust.email, customer_name: cust.name, snippet: (last.body || t.snippet || "").slice(0, 280),
    status, order_ref: order, last_message_at: last.sentAt, last_from_customer: lastFromCustomer, unread, in_spam: inSpam,
    updated_at: new Date().toISOString(),
    ...(cust.via !== "email" ? { category: cust.via } : notice ? { category: "notification", priority: 3 } : {}),
  };
  const { data: tk, error } = await admin.from("tickets").upsert(row, { onConflict: "store_key,gmail_thread_id" }).select("id").single();
  if (error) throw new MailError(`Hub database error: ${error.message}`);
  await admin.from("ticket_messages").upsert(msgs.map((m: any) => ({
    ticket_id: tk.id, gmail_message_id: m.id, rfc_message_id: m.rfcId, direction: mine(m) ? "out" : "in",
    from_addr: m.from, to_addr: m.to, subject: m.subject, sent_at: m.sentAt, body_text: m.body,
  })), { onConflict: "gmail_message_id" });
  return tk.id as string;
}

// Only threads whose Gmail historyId changed are re-read, and each run stops after `budgetMs`
// (the next run picks up the rest), so a big inbox never times the function out.
export async function syncStore(store_key: string, mailbox: string, days = 4, budgetMs = 110_000) {
  const t0 = Date.now();
  const listed = new Map<string, { hid: string; spam: boolean }>();
  for (const [q, spam] of [[`in:inbox newer_than:${days}d`, false], [`is:unread in:inbox newer_than:30d`, false], [`in:spam newer_than:${days}d`, true]] as const) {
    let pageToken = "";
    for (let i = 0; i < 4; i++) {
      const r = await gmail(mailbox, `/threads?maxResults=100&q=${encodeURIComponent(q)}${spam ? "&includeSpamTrash=true" : ""}${pageToken ? `&pageToken=${pageToken}` : ""}`);
      for (const th of r.threads ?? []) if (!listed.has(th.id)) listed.set(th.id, { hid: th.historyId, spam });
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
  }
  // Open Hub tickets that dropped out of those searches (archived/labelled by someone in Gmail) get refreshed too.
  const { data: known } = await admin.from("tickets").select("gmail_thread_id,gmail_history_id,status").eq("store_key", store_key);
  const knownMap = new Map((known ?? []).map((k) => [k.gmail_thread_id, k]));
  for (const k of known ?? []) if (k.status !== "done" && !listed.has(k.gmail_thread_id)) listed.set(k.gmail_thread_id, { hid: "", spam: false });

  let updated = 0, pending = 0;
  for (const [id, { hid, spam }] of listed) {
    const k = knownMap.get(id);
    if (k && hid && k.gmail_history_id === hid) continue;
    if (Date.now() - t0 > budgetMs) { pending++; continue; }
    try { await syncThread(store_key, mailbox, id, spam); updated++; }
    catch (e) { if (!/HTTP 404/.test((e as Error).message)) throw e; }
  }
  await completedLabel(store_key, mailbox);
  return { checked: listed.size, updated, pending };
}

// ---------- actions ----------
// Blanks Claude leaves for Brian: [[ADD: ship date]] or [[CHOOSE: option A || option B]] (old style [ADD ...] too).
export const BLANK_RE = /\[\[[^\]]+\]\]|\[(?:ADD|CHOOSE|INSERT|FILL|TBD|PICK)\b[^\]]*\]/gi;
export const findBlanks = (body: string) => body.match(BLANK_RE) ?? [];

function rfc2047(s: string) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`; }

export async function sendReply(ticketId: string, body: string, actor: string) {
  const blanks = findBlanks(body);
  if (blanks.length) throw new MailError(`Not sent: the reply still has ${blanks.length} blank${blanks.length > 1 ? "s" : ""} to fill in (${blanks.join(", ")}).`);
  const { data: t } = await admin.from("tickets").select("*, stores(support_email,name)").eq("id", ticketId).maybeSingle();
  if (!t) throw new MailError("No such ticket.");
  const mailbox: string = t.stores.support_email;
  const { data: msgs } = await admin.from("ticket_messages").select("rfc_message_id,from_addr,direction,subject").eq("ticket_id", ticketId).order("sent_at");
  const lastIn = [...(msgs ?? [])].reverse().find((m) => m.direction === "in");
  const refs = (msgs ?? []).map((m) => m.rfc_message_id).filter(Boolean);
  const replyTo = lastIn ? addr(lastIn.from_addr) : t.customer_email;
  // Shopify form mail: answer the customer, never mailer@shopify.com.
  const to = replyTo.endsWith("@shopify.com") ? t.customer_email : replyTo;
  if (!to || to.endsWith("@shopify.com")) throw new MailError("Couldn't work out the customer's address for this thread.");
  const subject = /^re:/i.test(t.subject ?? "") ? t.subject : `Re: ${t.subject ?? ""}`;
  const mime = [
    `From: ${rfc2047(t.stores.name)} <${mailbox}>`, `To: ${to}`, `Subject: ${rfc2047(subject)}`,
    ...(lastIn?.rfc_message_id ? [`In-Reply-To: ${lastIn.rfc_message_id}`, `References: ${refs.join(" ")}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", body,
  ].join("\r\n");
  const sent = await gmail(mailbox, "/messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(mime), threadId: t.gmail_thread_id }) });
  await admin.from("tickets").update({ status: "replied", last_from_customer: false, unread: false, draft_body: null, draft_reason: null, updated_at: new Date().toISOString() }).eq("id", ticketId);
  await gmail(mailbox, `/threads/${t.gmail_thread_id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) }).catch(() => null);
  await admin.from("audit_log").insert({ store_key: t.store_key, actor, action: "email_reply", summary: `Replied to ${to}: ${subject}`, status: "sent", ref: ticketId });
  await syncThread(t.store_key, mailbox, t.gmail_thread_id).catch(() => null);
  return { to, subject, message_id: sent.id as string };
}

export async function markDone(ticketId: string, actor: string) {
  const { data: t } = await admin.from("tickets").select("store_key,gmail_thread_id,subject,in_spam,stores(support_email)").eq("id", ticketId).maybeSingle();
  if (!t) throw new MailError("No such ticket.");
  const mailbox = (t as any).stores.support_email;
  const label = await completedLabel(t.store_key, mailbox);
  await gmail(mailbox, `/threads/${t.gmail_thread_id}/modify`, {
    method: "POST", body: JSON.stringify({ addLabelIds: [label], removeLabelIds: ["INBOX", "UNREAD", ...(t.in_spam ? ["SPAM"] : [])] }),
  });
  await admin.from("tickets").update({ status: "done", unread: false, in_spam: false, updated_at: new Date().toISOString() }).eq("id", ticketId);
  await admin.from("audit_log").insert({ store_key: t.store_key, actor, action: "email_done", summary: `Filed as Completed: ${t.subject}`, status: "done", ref: ticketId });
}
