import { useCallback, useEffect, useState } from "react";
import { callFn } from "./supabase";
import { navigate } from "./App";

type Money = { spend: number; value: number };
type StoreRow = {
  key: string; name: string; error: string | null;
  sales: { today: { revenue: number; orders: number }; last7: { revenue: number; orders: number }; currency: string } | null;
  meta: { today: Money; last7: Money } | null;
};
type Data = {
  generated_at: string; day: string; stores: StoreRow[]; meta_error: string | null;
  pending: { id: string; store_key: string; summary: string; created_at: string }[];
  alerts: { level: "red" | "gold"; store: string; title: string; detail: string }[];
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });
const roas = (m?: Money | null) => (m && m.spend > 0 ? m.value / m.spend : null);
const C = { cyan: "#38d6ff", gold: "#ffc24a", red: "#ff5d47", green: "#3ee08f" };

function Ring({ pct, color }: { pct: number; color: string }) {
  const c = 2 * Math.PI * 32, p = Math.max(0, Math.min(1, pct));
  return (
    <svg width="78" height="78" viewBox="0 0 78 78" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="39" cy="39" r="32" fill="none" stroke="rgba(56,214,255,0.15)" strokeWidth="6" />
      <circle cx="39" cy="39" r="32" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(c * p).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 39 39)" style={{ filter: `drop-shadow(0 0 4px ${color})`, transition: "stroke-dasharray .8s" }} />
      <circle cx="39" cy="39" r="22" fill="none" stroke="rgba(56,214,255,0.25)" strokeWidth="1" strokeDasharray="2 4" />
    </svg>
  );
}

function Kpi({ label, value, sub, subColor, pct, color }: { label: string; value: string; sub: string; subColor?: string; pct: number; color: string }) {
  return (
    <div className="panel kpi">
      <Ring pct={pct} color={color} />
      <div style={{ minWidth: 0 }}>
        <div className="label">{label}</div>
        <div className="big">{value}</div>
        <div className="sub" style={subColor ? { color: subColor } : undefined}>{sub}</div>
      </div>
      <span className="corner-a" aria-hidden="true" /><span className="corner-b" aria-hidden="true" />
    </div>
  );
}

export default function Overview({ onPending }: { onPending: (n: number) => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try { const x = await callFn<Data>("overview"); setD(x); setErr(""); onPending(x.pending.length); }
    catch (e) { setErr((e as Error).message); }
  }, [onPending]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const rows = (d?.stores ?? []).filter((s) => filter === "all" || s.key === filter);
  const sum = (f: (s: StoreRow) => number) => rows.reduce((a, s) => a + f(s), 0);
  const revToday = sum((s) => s.sales?.today.revenue ?? 0), rev7 = sum((s) => s.sales?.last7.revenue ?? 0);
  const ordToday = sum((s) => s.sales?.today.orders ?? 0);
  const spendToday = sum((s) => s.meta?.today.spend ?? 0), valToday = sum((s) => s.meta?.today.value ?? 0);
  const spend7 = sum((s) => s.meta?.last7.spend ?? 0), val7 = sum((s) => s.meta?.last7.value ?? 0);
  const avgDay = rev7 / 7;
  const alerts = (d?.alerts ?? []).filter((a) => filter === "all" || a.store === filter || a.store === "all");
  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// COMMAND OVERVIEW</div><h1>{greet}, Brian</h1></div>
        <div role="group" aria-label="Store filter" className="row" style={{ gap: 8 }}>
          <button className={`btn chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>ALL STORES</button>
          {(d?.stores ?? []).map((s) => (
            <button key={s.key} className={`btn chip ${filter === s.key ? "on" : ""}`} onClick={() => setFilter(s.key)}>{s.name.toUpperCase()}</button>
          ))}
          <button className="btn chip" style={{ borderStyle: "dashed", borderColor: "rgba(255,194,74,.6)", color: C.gold }} onClick={() => navigate("/stores")}>+ STORE</button>
        </div>
      </div>

      {err && <div className="panel hot" role="alert"><strong>Couldn't load the overview.</strong> <span className="sub">{err}</span></div>}
      {!d && !err && <div className="sub">Linking to stores…</div>}

      {d && (
        <>
          <section aria-label="Key numbers" className="grid">
            <Kpi label="REVENUE TODAY" value={usd(revToday)} pct={avgDay ? revToday / avgDay : 0} color={C.cyan}
              sub={avgDay ? `${Math.round((revToday / avgDay) * 100)}% of a typical day (${usd(avgDay)})` : "No sales in the last 7 days"} />
            <Kpi label="ORDERS TODAY" value={String(ordToday)} pct={ordToday / Math.max(1, sum((s) => s.sales?.last7.orders ?? 0) / 7)} color={C.cyan}
              sub={rows.map((s) => `${s.sales?.today.orders ?? "—"} ${s.key.toUpperCase()}`).join(" · ")} />
            <Kpi label="META SPEND TODAY" value={d.meta_error ? "—" : usd(spendToday)} pct={roas({ spend: spend7, value: val7 }) ? (roas({ spend: spend7, value: val7 })! / 3) : 0} color={C.gold}
              sub={d.meta_error ? d.meta_error : `Today ${roas({ spend: spendToday, value: valToday })?.toFixed(2) ?? "—"}× · 7 days ${roas({ spend: spend7, value: val7 })?.toFixed(2) ?? "—"}×`}
              subColor={d.meta_error ? C.gold : (roas({ spend: spend7, value: val7 }) ?? 0) >= 1.5 ? C.green : C.gold} />
            <Kpi label="AWAITING YOU" value={String(d.pending.length)} pct={d.pending.length ? 1 : 0} color={d.pending.length ? C.gold : C.green}
              sub={d.pending.length ? "Changes staged by Claude" : "Nothing waiting"} subColor={d.pending.length ? C.gold : undefined} />
          </section>

          <section aria-label="Stores" className="grid wide">
            {rows.map((s) => {
              const r7 = roas(s.meta?.last7);
              const col = s.error ? C.red : C.green;
              return (
                <div className="panel" key={s.key}>
                  <div className="store-head">
                    <span className="dot pulse" style={{ width: 9, height: 9, background: col, boxShadow: `0 0 8px ${col}` }} />
                    <span className="name">{s.name}</span>
                    <span className="state">{s.error ? "UNREACHABLE" : "LINKED"}</span>
                  </div>
                  {s.error ? <div className="err">{s.error}</div> : (
                    <div className="stats3">
                      <div><div className="label">TODAY</div><div className="mid">{usd(s.sales!.today.revenue)}</div></div>
                      <div><div className="label">ORDERS</div><div className="mid">{s.sales!.today.orders}</div></div>
                      <div><div className="label">7 DAYS</div><div className="mid">{usd(s.sales!.last7.revenue)}</div></div>
                    </div>
                  )}
                  {s.meta && (
                    <div className="ads">
                      <span className="label mono">META ADS</span>
                      <span>{usd(s.meta.today.spend)} today · 7d {usd(s.meta.last7.spend)} at{" "}
                        <strong style={{ color: r7 === null ? undefined : r7 < 1 ? C.red : r7 < 1.5 ? C.gold : C.green }}>{r7?.toFixed(2) ?? "—"}×</strong></span>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          <div className="row">
            <section aria-label="Alerts" className="panel hot" style={{ flex: "1 1 360px", minWidth: 0 }}>
              <div className="between" style={{ marginBottom: 8 }}>
                <h2 style={{ color: "#ff8b78" }}>ALERTS</h2><span className="mono" style={{ color: "#ff8b78" }}>{alerts.length} ACTIVE</span>
              </div>
              {alerts.length === 0 && <div className="sub">All clear.</div>}
              {alerts.map((a, i) => (
                <div className="list-item" key={i}>
                  <span className="diamond" style={{ background: a.level === "red" ? C.red : C.gold, boxShadow: `0 0 6px ${a.level === "red" ? C.red : C.gold}` }} />
                  <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{a.title}</div><div className="sub">{a.detail}</div></div>
                  <span className="tag">{a.store}</span>
                </div>
              ))}
            </section>

            <section aria-label="Changes awaiting approval" className="panel warm" style={{ flex: "1 1 360px", minWidth: 0 }}>
              <div className="between" style={{ marginBottom: 8 }}>
                <h2 style={{ color: "#ffd98a" }}>CLAUDE · AWAITING YOU</h2>
                <a href="/changes" className="mono" onClick={(e) => { e.preventDefault(); navigate("/changes"); }}>OPEN APPROVALS →</a>
              </div>
              {d.pending.length === 0 && <div className="sub">No staged changes. When Claude proposes one, it shows here for a one-click yes or no.</div>}
              {d.pending.slice(0, 4).map((p) => (
                <div className="list-item" key={p.id}>
                  <span className="mono" style={{ color: C.gold }}>{p.store_key.toUpperCase()}</span>
                  <div style={{ minWidth: 0 }}>{p.summary}</div>
                </div>
              ))}
            </section>
          </div>

          <div className="foot">LIVE · REFRESHES EVERY MINUTE · LAST UPDATE {new Date(d.generated_at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} ET · META FIGURES TRAIL BY ~30 MIN</div>
        </>
      )}
    </>
  );
}
