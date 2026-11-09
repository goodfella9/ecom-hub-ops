import { createClient } from "@supabase/supabase-js";

// Public values: the project URL and its publishable key are safe in the browser.
// Everything sensitive lives in Supabase secrets and is enforced server-side.
export const SUPABASE_URL = "https://rvhjfxzwxidzcdbtbxcg.supabase.co";
export const SUPABASE_KEY = "sb_publishable_N4Q5A-WDSa4mC_dgTSqKuw_lOEF--Mv";
export const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export async function callFn<T>(name: string, body?: unknown): Promise<T> {
  const { data: s } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${s.session?.access_token ?? ""}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description ?? json.error ?? `HTTP ${res.status}`);
  return json as T;
}
