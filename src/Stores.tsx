import { useCallback, useEffect, useState } from "react";
import { MCP_URL, SUPABASE_KEY, SUPABASE_URL, supabase } from "./supabase";

type Store = { key: string; name: string; shopify_domain: string; support_email: string | null; active: boolean; meta_account_id: string | null };
type Health = { store_key: string; ok: boolean; shop_name: string | null; scopes: string[]; detail: string; checked_at: string };

export default function Stores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ key: "", name: "", domain: "" });
  const [formMsg, setFormMsg] = useState("");

  const load = useCallback(async () => {
    const [s, h] = await Promise.all([
      supabase.from("stores").select("key,name,shopify_domain,support_email,active,meta_account_id").order("created_at"),
      supabase.from("store_health").select("*"),
    ]);
    setStores(s.data ?? []);
    setHealth(Object.fromEntries((h.data ?? []).map((x: Health) => [x.store_key, x])));
  }, []);
  useEffect(() => { load(); }, [load]);

  const check = async () => {
    setChecking(true);
    await fetch(`${SUPABASE_URL}/functions/v1/store-health`, { method: "POST", headers: { apikey: SUPABASE_KEY } }).catch(() => null);
    await load(); setChecking(false);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setFormMsg("");
    const key = form.key.trim().toLowerCase(), domain = form.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const { error } = await supabase.from("stores").insert({ key, name: form.name.trim(), shopify_domain: domain });
    if (error) { setFormMsg(error.message); return; }
    setFormMsg(`Added. Next: create its Shopify app, then add secrets SHOP_${key.toUpperCase()}_CLIENT_ID and SHOP_${key.toUpperCase()}_CLIENT_SECRET in Supabase, then Run check.`);
    setForm({ key: "", name: "", domain: "" }); load();
  };

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// STORES</div><h1>Connected stores</h1></div>
        <button className="btn primary" onClick={check} disabled={checking}>{checking ? "CHECKING…" : "RUN CHECK"}</button>
      </div>

      <section className="grid wide" aria-label="Stores">
        {stores.map((s) => {
          const h = health[s.key];
          const col = !h ? "#7fa9bf" : h.ok ? "#3ee08f" : "#ff5d47";
          return (
            <div className="panel" key={s.key}>
              <div className="store-head">
                <span className="dot" style={{ width: 9, height: 9, background: col, boxShadow: `0 0 8px ${col}` }} />
                <span className="name">{s.name}</span>
                <span className="state">{s.key.toUpperCase()}</span>
              </div>
              <div className="sub mono">{s.shopify_domain}</div>
              <div className="sub" style={{ marginTop: 8, color: h?.ok ? "#3ee08f" : h ? "#ff8b78" : undefined }}>
                {h ? (h.ok ? `Linked · ${h.scopes.length} permission sets` : h.detail) : "Not checked yet"}
              </div>
              {h && <div className="sub">Checked {new Date(h.checked_at).toLocaleString("en-US", { timeZone: "America/New_York" })}</div>}
              <div className="sub" style={{ marginTop: 8 }}>Meta ad account: <span className="mono">{s.meta_account_id ?? "not set"}</span></div>
            </div>
          );
        })}
      </section>

      <section className="panel" aria-label="Claude connector">
        <h2 style={{ color: "#38d6ff", marginBottom: 8 }}>CLAUDE CONNECTOR</h2>
        <p className="sub" style={{ marginTop: 0 }}>Add this URL in claude.ai under Settings → Connectors → Add custom connector. Claude signs in through this Hub, once.</p>
        <div className="copy">
          <code>{MCP_URL}</code>
          <button className="btn chip" onClick={() => navigator.clipboard.writeText(MCP_URL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? "COPIED" : "COPY"}</button>
        </div>
      </section>

      <form className="panel" onSubmit={add} aria-label="Add a store">
        <h2 style={{ color: "#ffc24a", marginBottom: 12 }}>ADD A STORE</h2>
        <div className="grid">
          <label className="field"><span className="label">SHORT KEY</span><input required pattern="[a-z0-9]{2,16}" placeholder="dale" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></label>
          <label className="field"><span className="label">NAME</span><input required placeholder="Dale Duro" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span className="label">MYSHOPIFY DOMAIN</span><input required placeholder="dale-duro.myshopify.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} /></label>
        </div>
        <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
          <button className="btn gold">ADD STORE</button>
          {formMsg && <span className="sub" role="status">{formMsg}</span>}
        </div>
      </form>
    </>
  );
}
