// Ecom Hub Ops — Claude connector (remote MCP server).
// Auth: Supabase Auth OAuth 2.1 (claude.ai signs in as Brian). Only users in app_admins get tools.
// Shopify: one Dev Dashboard app per store; client credentials -> 24h tokens cached in shopify_tokens.
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@^2.0.0";
import { pipeline } from "npm:@supabase/middleware@1";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@^4.3.6";

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
    return fail(e instanceof StoreError ? e.message : `Unexpected error: ${(e as Error).message}`);
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
        "Brian can also approve staged changes in the Hub at ecomhubops.com. If a store can't be reached, report it as a connection problem, never as zero results.",
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
