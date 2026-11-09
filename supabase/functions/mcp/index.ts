// Ecom Hub Ops — Claude connector (remote MCP server).
// Auth: Supabase Auth OAuth 2.1 (claude.ai signs in as Brian). Only users in app_admins get tools.
// Shopify: one Dev Dashboard app per store; client credentials -> 24h tokens cached in shopify_tokens.
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@^2.0.0";
import { pipeline } from "npm:@supabase/middleware@1";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@^4.3.6";
import { gmail, markDone, MailError, parseMessage, sendReply, syncStore } from "../_shared/gmail.ts";
import { prepareActions } from "../_shared/actions.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-10";
const CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return keys.default ?? Object.values(keys)[0] as string;
  } catch {
    return "";
  }
}
const admin = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false } });

class StoreError extends Error {}

type Store = { key: string; name: string; shopify_domain: string; active: boolean };

async function getStore(key: string): Promise<Store> {
  const { data, error } = await admin.from("stores").select("key,name,shopify_domain,active").eq("key", key.trim().toLowerCase()).maybeSingle();
  if (error) throw new StoreError(`Hub database error: ${error.message}`);
  if (!data) {
    const { data: all } = await admin.from("stores").select("key").eq("active", true);
    throw new StoreError(`Unknown store "${key}". Stores: ${(all ?? []).map((s) => s.key).join(", ")}.`);
  }
  if (!data.active) throw new StoreError(`${data.name} is switched off in the Hub.`);
  return data;
}

async function shopToken(s: Store, force = false): Promise<{ token: string; scope: string }> {
  if (!force) {
    const { data } = await admin.from("shopify_tokens").select("access_token,scope,expires_at").eq("store_key", s.key).maybeSingle();
    if (data && new Date(data.expires_at).getTime() - Date.now() > 5 * 60_000) return { token: data.access_token, scope: data.scope };
  }
  const p = `SHOP_${s.key.toUpperCase()}_`;
  const id = Deno.env.get(p + "CLIENT_ID"), secret = Deno.env.get(p + "CLIENT_SECRET");
  if (!id || !secret) throw new StoreError(`${s.name} isn't connected yet: its Shopify app keys aren't in the Hub's secrets.`);
  const res = await fetch(`https://${s.shopify_domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new StoreError(`Couldn't reach ${s.name}: Shopify refused the app keys (HTTP ${res.status}: ${text.slice(0, 200)}). This is a connection problem, not missing data.`);
  }
  const body = JSON.parse(text);
  const expires = new Date(Date.now() + (Number(body.expires_in) || 86399) * 1000).toISOString();
  await admin.from("shopify_tokens").upsert({ store_key: s.key, access_token: body.access_token, scope: body.scope ?? "", expires_at: expires, updated_at: new Date().toISOString() });
  return { token: body.access_token, scope: body.scope ?? "" };
}

async function shopGraphQL(s: Store, query: string, variables: Record<string, unknown> = {}) {
  const call = async (force: boolean) => {
    const { token } = await shopToken(s, force);
    return fetch(`https://${s.shopify_domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables }),
    });
  };
  let res = await call(false);
  if (res.status === 401) res = await call(true);
  const text = await res.text();
  if (!res.ok) throw new StoreError(`Couldn't reach ${s.name} (HTTP ${res.status}: ${text.slice(0, 300)}). This is a connection problem, not missing data.`);
  return JSON.parse(text);
}

// Operation kinds at the top level, ignoring comments and strings.
function operationKinds(gql: string): string[] {
  const cleaned = gql.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""');
  const kinds: string[] = [];
  let depth = 0;
  const re = /[{}]|\b(query|mutation|subscription|fragment)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[0] === "{") { if (depth === 0 && kinds.length === 0) kinds.push("query"); depth++; }
    else if (m[0] === "}") depth--;
    else if (depth === 0) kinds.push(m[1]);
  }
  return kinds;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });
const safe = <A,>(fn: (a: A) => Promise<any>) => async (a: A) => {
  try { return await fn(a); } catch (e) {
    console.error("tool error", e);
    return fail(e instanceof StoreError || e instanceof MailError ? e.message : `Unexpected error: ${(e as Error).message}`);
  }
};
const STORE = z.string().describe('Store key: "cmp" Cover My Plate, "mvp" My MVP Card, "arca" Arca Gear. Call list_stores for the current list.');

function buildServer(actor: string) {
  const server = new McpServer(
    { name: "ecom-hub-ops", version: "1.0.0" },
    {
      instructions:
        "Ecom Hub Ops: Brian's Shopify stores (Cover My Plate, My MVP Card, Arca Gear, and any added later) through one connection, via the Shopify Admin GraphQL API. " +
        "Every tool takes a store key. Reads: shopify_query. Changes are two steps: propose_change stages a mutation with a plain-English summary; apply_change runs it. " +
        "Call apply_change only after Brian approves that summary, or when the running task's own instructions explicitly pre-approve that kind of change. " +
        "Brian can also approve staged changes in the Hub at ecomhubops.com. If a store can't be reached, report it as a connection problem, never as zero results. " +
        "Support inbox: each store's support@ mailbox syncs into tickets. Before answering a store's customers, read that store's playbook (get_playbook) — the stores are separate companies with separate voices and policies. " +
        "Routine replies the playbook allows: inbox_reply then inbox_done. Anything needing Brian: inbox_stage_reply (with a draft) or inbox_flag (no draft). " +
        "Every ticket has a number (ticket_no). When talking to Brian, always refer to tickets as #<number> with the store and customer, e.g. '#1001 (CMP, Jennifer Albert)', and accept #numbers from him.",
    },
  );

  server.registerTool("list_stores", {
    description: "List the Hub's stores with their keys, and whether each is reachable right now (with the permissions its app has).",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, safe(async () => {
    const { data } = await admin.from("stores").select("key,name,shopify_domain,active").order("created_at");
    const out = [];
    for (const s of (data ?? []) as Store[]) {
      if (!s.active) { out.push({ key: s.key, name: s.name, status: "switched off" }); continue; }
      try { const t = await shopToken(s); out.push({ key: s.key, name: s.name, domain: s.shopify_domain, status: "ok", scopes: t.scope.split(",") }); }
      catch (e) { out.push({ key: s.key, name: s.name, domain: s.shopify_domain, status: "error", error: (e as Error).message }); }
    }
    return text(out);
  }));

  server.registerTool("shopify_query", {
    description: "Run a READ-ONLY Shopify Admin GraphQL query against one store: orders, products, inventory, customers, fulfillments, analytics (shopifyqlQuery), etc. Mutations are refused; use propose_change. Paginate with pageInfo/endCursor.",
    inputSchema: z.object({
      store: STORE,
      query: z.string().describe("GraphQL query document (no mutations)."),
      variables: z.record(z.string(), z.any()).optional(),
    }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store, query, variables }) => {
    if (operationKinds(query).some((k) => k === "mutation" || k === "subscription")) return fail("shopify_query is read-only. Use propose_change, then apply_change.");
    const s = await getStore(store);
    return text({ store: s.name, ...(await shopGraphQL(s, query, variables ?? {})) });
  }));

  server.registerTool("propose_change", {
    description: "Step 1 of 2 to change a store. Stages ONE Shopify Admin GraphQL mutation without running it and returns a change_id. Write `summary` in plain English for Brian: store, which order/product/customer, exactly what changes (e.g. 'CMP order #18412: add tag replacement-18390'). Show it to the user, then call apply_change. Expires after 24 hours. Staged changes also appear in the Hub for one-click approval.",
    inputSchema: z.object({
      store: STORE,
      mutation: z.string().describe("A single GraphQL mutation document."),
      variables: z.record(z.string(), z.any()).optional(),
      summary: z.string().min(10).describe("Plain-English description of exactly what will change."),
    }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store, mutation, variables, summary }) => {
    const kinds = operationKinds(mutation).filter((k) => k !== "fragment");
    if (kinds.length !== 1 || kinds[0] !== "mutation") return fail("propose_change takes exactly one mutation. Use shopify_query for reads.");
    const s = await getStore(store);
    const { data, error } = await admin.from("pending_changes").insert({ store_key: s.key, mutation, variables: variables ?? {}, summary, source: actor }).select("id").single();
    if (error) throw new StoreError(`Hub database error: ${error.message}`);
    return text({ change_id: data.id, store: s.name, summary, next: "Nothing has changed yet. Show the summary; call apply_change once approved (or if this task pre-approves this kind of change)." });
  }));

  server.registerTool("apply_change", {
    description: "Step 2 of 2. Runs a change staged with propose_change. Only after Brian approved that summary, or when the running task's instructions explicitly pre-approve this kind of change. Each change runs once.",
    inputSchema: z.object({ change_id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, safe(async ({ change_id }) => {
    // Claim it atomically so a retry can't double-apply.
    const { data: claimed } = await admin.from("pending_changes")
      .update({ status: "applying", decided_at: new Date().toISOString(), decided_by: actor })
      .eq("id", change_id).eq("status", "pending").gt("created_at", new Date(Date.now() - CHANGE_TTL_MS).toISOString())
      .select("*").maybeSingle();
    if (!claimed) {
      const { data: c } = await admin.from("pending_changes").select("status,created_at").eq("id", change_id).maybeSingle();
      return fail(!c ? "No such change. Propose it again." : c.status !== "pending" ? `This change is already ${c.status}.` : "This proposal expired. Propose it again.");
    }
    const s = await getStore(claimed.store_key);
    let body: any, status = "applied";
    try {
      body = await shopGraphQL(s, claimed.mutation, claimed.variables);
      if (body.errors || /"userErrors":\[(?!\])/.test(JSON.stringify(body))) status = "failed";
    } catch (e) { body = { error: (e as Error).message }; status = "failed"; }
    await admin.from("pending_changes").update({ status, result: body }).eq("id", change_id);
    await admin.from("audit_log").insert({ store_key: s.key, actor, action: "apply_change", summary: claimed.summary, status, ref: change_id });
    return status === "applied" ? text({ store: s.name, applied: claimed.summary, result: body }) : fail(JSON.stringify({ store: s.name, summary: claimed.summary, result: body }, null, 2));
  }));

  server.registerTool("list_pending_changes", {
    description: "List changes staged but not yet applied (newest first), optionally for one store.",
    inputSchema: z.object({ store: STORE.optional() }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store }) => {
    let q = admin.from("pending_changes").select("id,store_key,summary,created_at,source").eq("status", "pending").gt("created_at", new Date(Date.now() - CHANGE_TTL_MS).toISOString()).order("created_at", { ascending: false }).limit(50);
    if (store) q = q.eq("store_key", store.toLowerCase());
    const { data } = await q;
    return text(data ?? []);
  }));

  server.registerTool("recent_changes", {
    description: "The Hub's audit log: changes applied to the stores, newest first.",
    inputSchema: z.object({ store: STORE.optional(), limit: z.number().int().min(1).max(100).optional() }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store, limit }) => {
    let q = admin.from("audit_log").select("at,store_key,actor,action,summary,status").order("at", { ascending: false }).limit(limit ?? 20);
    if (store) q = q.eq("store_key", store.toLowerCase());
    const { data } = await q;
    return text(data ?? []);
  }));

  // ---------------- Support inbox ----------------
  const TICKET = z.union([z.string(), z.number()]).describe("Ticket number shown in inbox_list (e.g. 1001, #1001 or CMP-1001), or its id.");
  const loadTicket = async (ref: string | number) => {
    const r = String(ref).trim();
    const num = r.match(/^(?:[a-z]+-)?#?(\d{1,9})$/i)?.[1];
    if (num) {
      const { data } = await admin.from("tickets").select("*, stores(name,support_email)").eq("ticket_no", Number(num)).maybeSingle();
      if (!data) throw new StoreError(`No ticket #${num}. Call inbox_list for current numbers.`);
      return data;
    }
    const id = r;
    const { data } = await admin.from("tickets").select("*, stores(name,support_email)").eq("id", id).maybeSingle();
    if (!data) throw new StoreError("No such ticket. Call inbox_list for current ids.");
    return data;
  };

  server.registerTool("get_playbook", {
    description: "A store's support playbook: voice/signature, what may be sent without approval, what must go to Brian, and its policies. Each store is a different company with its own rules. ALWAYS read the store's playbook before replying to that store's customers, and never apply one store's policies to another.",
    inputSchema: z.object({ store: STORE }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store }) => {
    const { data } = await admin.from("store_playbooks").select("*").eq("store_key", store.toLowerCase()).maybeSingle();
    if (!data) return fail(`No playbook for "${store}" yet.`);
    return text(data);
  }));

  server.registerTool("inbox_list", {
    description: "List support tickets (one per email thread) across all stores or one store. Default shows open work: new, needs_you, awaiting_approval. Statuses: new (customer waiting, untouched), needs_you (flagged for Brian), awaiting_approval (reply drafted, waiting for Brian in the Hub), replied (we answered last), done (filed with the Completed label).",
    inputSchema: z.object({
      store: STORE.optional(),
      status: z.enum(["open", "new", "needs_you", "awaiting_approval", "replied", "done", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      include_notifications: z.boolean().optional().describe("Also list system mail (Shopify/ad/shipping notifications, no-reply senders). Off by default; file those with inbox_done in bulk when the playbook says to."),
    }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store, status, limit, include_notifications }) => {
    let q = admin.from("tickets").select("ticket_no,id,store_key,status,subject,customer_name,customer_email,category,order_ref,snippet,last_message_at,last_from_customer,unread,in_spam,draft_body,note")
      .order("last_message_at", { ascending: false }).limit(limit ?? 50);
    if (store) q = q.eq("store_key", store.toLowerCase());
    const st = status ?? "open";
    if (st === "open") q = q.in("status", ["new", "needs_you", "awaiting_approval"]);
    else if (st !== "all") q = q.eq("status", st);
    if (!include_notifications) q = q.or("category.is.null,category.neq.notification");
    const { data } = await q;
    let nq = admin.from("tickets").select("id", { count: "exact", head: true }).eq("category", "notification").neq("status", "done");
    if (store) nq = nq.eq("store_key", store.toLowerCase());
    const { count: notices } = await nq;
    const { data: sync } = await admin.from("gmail_sync_state").select("store_key,mailbox,last_sync_at,ok,detail");
    return text({ inbox_connection: sync ?? [], unfiled_notifications: notices ?? 0, tickets: (data ?? []).map((t) => ({ ...t, draft_body: t.draft_body ? "(draft waiting)" : null })) });
  }));

  server.registerTool("inbox_thread", {
    description: "Read a ticket's full email thread (every message, oldest first, quoted history removed) plus its store's playbook. Read this before replying so you never repeat or contradict an earlier reply.",
    inputSchema: z.object({ ticket_id: TICKET }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ ticket_id }) => {
    const t = await loadTicket(ticket_id);
    const [{ data: msgs }, { data: pb }] = await Promise.all([
      admin.from("ticket_messages").select("direction,from_addr,to_addr,subject,sent_at,body_text").eq("ticket_id", t.id).order("sent_at"),
      admin.from("store_playbooks").select("*").eq("store_key", t.store_key).maybeSingle(),
    ]);
    return text({ ticket: { ...t, stores: undefined, store: t.stores.name, mailbox: t.stores.support_email }, messages: msgs ?? [], playbook: pb });
  }));

  server.registerTool("inbox_reply", {
    description: "Send a reply on a ticket's thread from the store's support mailbox, right now. Use ONLY for replies the store's playbook lists as routine (auto_send), or text Brian has explicitly approved. Money, refunds, remakes, discounts, judgment calls and anything in needs_approval go through inbox_stage_reply instead. Write in that store's voice and signature.",
    inputSchema: z.object({
      ticket_id: TICKET,
      body: z.string().min(2).describe("Plain-text reply, complete with greeting and signature."),
      reason: z.string().min(3).describe("Which playbook rule makes this routine, e.g. 'order status with tracking'."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, safe(async ({ ticket_id, body, reason }) => {
    const t = await loadTicket(ticket_id);
    if (t.status === "done") return fail("This ticket is already filed as done. If the customer wrote again, run inbox_sync first.");
    const r = await sendReply(t.id, body, `${actor} (${reason})`);
    return text({ sent: true, store: t.stores.name, ...r, next: "Call inbox_done if nothing else is needed on this thread." });
  }));

  server.registerTool("inbox_stage_reply", {
    description: "Draft a reply for Brian to approve instead of sending it. It shows in the Hub inbox with your reason; Brian edits/sends with one click. Use for anything outside the playbook's routine list. Never promise a price, date, refund or outcome in a draft unless Brian supplied it. Where Brian must decide or supply something, write a blank: [[CHOOSE: first full sentence option || second full sentence option]] (each option is complete text that replaces the blank) or [[ADD: what's needed, e.g. ship date]]. The Hub shows blanks in red with one-tap options and will not send until every blank is filled. Never use any other placeholder style.",
    inputSchema: z.object({
      ticket_id: TICKET,
      body: z.string().min(2),
      reason: z.string().min(3).describe("Why Brian needs to decide, plus your recommendation (one or two lines)."),
      actions: z.array(z.object({
        id: z.string().optional(),
        when: z.string().nullable().optional().describe("Exact text of the CHOOSE option this action belongs to (copy it character-for-character). Omit to run whenever the reply is sent."),
        type: z.enum(["invoice", "cancel_refund", "refund_items", "replacement", "tag_order", "notify_team", "upgrade_shipping"]),
        order: z.string().optional().describe("Order name, e.g. 18778 or AG61318 (cancel_refund, replacement, tag_order)."),
        email: z.string().optional().describe("invoice: customer's email."),
        items: z.array(z.object({ title: z.string(), price: z.number().optional(), qty: z.number().int().optional(), variant_id: z.string().optional() })).optional().describe("invoice: [{title, price, qty}] custom lines. replacement: [{title (matches an original line item), qty}] or [{title, variant_id, qty}] to send a different product/size (look the variant id up with shopify_query); omit to replace everything. refund_items: [{title (matches an original line item), qty}]."),
        amount: z.number().optional().describe("refund_items: refund this fixed amount instead of specific items (e.g. the bottle part of a combo)."),
        tags: z.array(z.string()).optional(),
        to: z.string().optional(), subject: z.string().optional(), body: z.string().optional(),
        note: z.string().optional(), message: z.string().optional(), restock: z.boolean().optional(),
        title: z.string().optional().describe("upgrade_shipping: new shipping method exactly as ShipStation should see it, e.g. 'UPS 2nd Day Air'."),
        extra: z.number().optional().describe("upgrade_shipping: what the customer pays on top of the shipping they already paid (0 = free upgrade). Shopify emails them a payment link for it on the same order."),
      })).optional().describe("Shopify/team actions the Hub runs BEFORE sending when Brian approves: invoice (draft order + emailed invoice), cancel_refund (cancel + full refund), refund_items (partial refund of some items or a fixed amount, order stays open), replacement ($0 order, same address), tag_order, notify_team (email an internal address like graphics@covermyplate.com), upgrade_shipping (change the order's own shipping method so ShipStation ships it that way, and invoice the difference on the same order; use this, not invoice, for shipping upgrades). Attach one to every option whose text promises something (an invoice, refund, reship, rush). If an action fails, the email isn't sent."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ticket_id, body, reason, actions }) => {
    const t = await loadTicket(ticket_id);
    const prep = prepareActions(actions as any, t.store_key);
    if (prep.error) return fail(`Action rejected: ${prep.error}`);
    await admin.from("tickets").update({ draft_body: body, draft_reason: reason, draft_actions: prep.actions, draft_by: actor, draft_at: new Date().toISOString(), status: "awaiting_approval", updated_at: new Date().toISOString() }).eq("id", t.id);
    return text({ staged: true, ticket: `#${t.ticket_no}`, actions: prep.actions.map((a) => ({ when: a.when ?? "always", does: a.summary })), next: "Waiting for Brian in the Hub inbox. Nothing was sent or changed." });
  }));

  server.registerTool("inbox_flag", {
    description: "Flag a ticket for Brian with no draft (e.g. track/racing questions for CMP, legal, partnership pitches, anything unsure). Leaves the email unread in the inbox.",
    inputSchema: z.object({
      ticket_id: TICKET,
      note: z.string().min(3).describe("What the customer wants and your recommendation."),
      priority: z.number().int().min(1).max(3).optional().describe("1 urgent, 2 normal (default), 3 low."),
      category: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ticket_id, note, priority, category }) => {
    const t = await loadTicket(ticket_id);
    await admin.from("tickets").update({ status: "needs_you", note, priority: priority ?? 2, ...(category ? { category } : {}), updated_at: new Date().toISOString() }).eq("id", t.id);
    return text({ flagged: true, ticket: `#${t.ticket_no}` });
  }));

  server.registerTool("inbox_done", {
    description: "File a ticket: adds the Gmail label Completed, archives it out of the inbox and marks it read. Use after replying, or for threads needing no reply (thank-yous, notifications, newsletters, pitches Brian doesn't want). Never on flagged or awaiting-approval threads.",
    inputSchema: z.object({ ticket_id: TICKET }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ticket_id }) => {
    const t = await loadTicket(ticket_id);
    if (t.status === "awaiting_approval" || t.status === "needs_you") return fail(`This ticket is ${t.status}; it stays open for Brian.`);
    await markDone(t.id, actor);
    return text({ done: true, ticket: `#${t.ticket_no}` });
  }));

  server.registerTool("inbox_sync", {
    description: "Pull the latest mail into the Hub now (it also syncs automatically every 5 minutes). Returns per-store results; a store error means that mailbox isn't connected yet, not that it's empty.",
    inputSchema: z.object({ store: STORE.optional() }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store }) => {
    let q = admin.from("stores").select("key,support_email").eq("active", true).not("support_email", "is", null);
    if (store) q = q.eq("key", store.toLowerCase());
    const { data } = await q;
    const out: Record<string, unknown> = {};
    for (const s of data ?? []) {
      try {
        const r = await syncStore(s.key, s.support_email, 4, 35_000);
        await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: true, detail: `${r.checked} threads watched, ${r.updated} updated${r.pending ? `, ${r.pending} still loading` : ""}` });
        out[s.key] = { ok: true, ...r };
      } catch (e) {
        await admin.from("gmail_sync_state").upsert({ store_key: s.key, mailbox: s.support_email, last_sync_at: new Date().toISOString(), ok: false, detail: (e as Error).message.slice(0, 500) });
        out[s.key] = { ok: false, error: (e as Error).message };
      }
    }
    return text(out);
  }));

  server.registerTool("inbox_sent_samples", {
    description: "Recent replies the store's support mailbox sent (straight from Gmail's Sent folder), to learn that store's real voice before updating its playbook.",
    inputSchema: z.object({ store: STORE, limit: z.number().int().min(1).max(40).optional() }),
    annotations: { readOnlyHint: true },
  }, safe(async ({ store, limit }) => {
    const { data: s } = await admin.from("stores").select("support_email").eq("key", store.toLowerCase()).maybeSingle();
    if (!s?.support_email) return fail("That store has no support mailbox set.");
    const r = await gmail(s.support_email, `/messages?maxResults=${limit ?? 20}&q=${encodeURIComponent("in:sent newer_than:180d")}`);
    const out = [];
    for (const m of r.messages ?? []) {
      const p = parseMessage(await gmail(s.support_email, `/messages/${m.id}?format=full`));
      out.push({ to: p.to, subject: p.subject, sent_at: p.sentAt, body: p.body.slice(0, 2000) });
    }
    return text(out);
  }));

  server.registerTool("update_playbook", {
    description: "Change a store's support playbook. Only when Brian asks for a rule change, or to save a voice profile learned from inbox_sent_samples after showing Brian the summary. Sections: signer, voice, auto_send, needs_approval, policies, notes.",
    inputSchema: z.object({
      store: STORE,
      section: z.enum(["signer", "voice", "auto_send", "needs_approval", "policies", "notes"]),
      text: z.string().min(1),
      mode: z.enum(["replace", "append"]).optional().describe("append (default) adds a line; replace rewrites the section."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ store, section, text: t, mode }) => {
    const { data: pb } = await admin.from("store_playbooks").select("*").eq("store_key", store.toLowerCase()).maybeSingle();
    if (!pb) return fail(`No playbook for "${store}".`);
    const next = mode === "replace" ? t : [pb[section], t].filter(Boolean).join("\n");
    await admin.from("store_playbooks").update({ [section]: next, version: pb.version + 1, updated_by: actor, updated_at: new Date().toISOString() }).eq("store_key", pb.store_key);
    await admin.from("audit_log").insert({ store_key: pb.store_key, actor, action: "playbook_update", summary: `${section}: ${t.slice(0, 200)}`, status: "applied" });
    return text({ updated: section, store: pb.store_key, version: pb.version + 1 });
  }));

  return server;
}

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
    async (req: Request, ctx: any) => {
      const { data: isAdmin, error } = await ctx.supabase.rpc("is_admin");
      if (error || isAdmin !== true) {
        return Response.json({ error: "forbidden", error_description: "This account isn't allowed to use the Hub." }, { status: 403 });
      }
      const { data: u } = await ctx.supabase.auth.getUser();
      const actor = `claude:${u?.user?.email ?? "user"}`;
      return createMcpHandler(() => buildServer(actor)).fetch(req);
    },
  ),
);
