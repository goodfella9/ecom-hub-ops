import { useEffect, useState } from "react";
import { supabase } from "./supabase";

type Row = { id: number; email: string; stores: string | null; source: string | null; created_at: string };

export default function Waitlist({ onCount }: { onCount: (n: number) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase.from("waitlist").select("id,email,stores,source,created_at").order("created_at", { ascending: false }).limit(1000);
      if (error) setErr(error.message); else { setRows(data ?? []); onCount((data ?? []).length); }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [onCount]);

  const csv = () => {
    const lines = ["email,stores,signed_up", ...(rows ?? []).map((r) => `${r.email},${r.stores ?? ""},${r.created_at}`)];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `ecomhubops-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const today = (rows ?? []).filter((r) => Date.now() - new Date(r.created_at).getTime() < 86_400_000).length;
  const buckets = ["1", "2-3", "4-10", "10+"].map((b) => ({ b, n: (rows ?? []).filter((r) => r.stores === b).length }));

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// WAITLIST · ECOMHUBOPS.COM</div><h1>Early-access sign-ups</h1></div>
        <button className="btn primary" onClick={csv} disabled={!rows?.length}>DOWNLOAD CSV</button>
      </div>
      {err && <div className="panel hot" role="alert">{err}</div>}
      <section className="grid" aria-label="Waitlist totals">
        <div className="panel kpi"><div><div className="label">TOTAL SIGN-UPS</div><div className="big">{rows?.length ?? "—"}</div><div className="sub">{today} in the last 24 hours</div></div></div>
        {buckets.map((x) => (
          <div className="panel" key={x.b}><div className="label">RUN {x.b} STORE{x.b === "1" ? "" : "S"}</div><div className="big">{x.n}</div></div>
        ))}
      </section>
      <section className="panel" aria-label="Sign-ups">
        <div className="scroll-x">
          <table>
            <thead><tr><th>EMAIL</th><th>STORES</th><th>SIGNED UP</th></tr></thead>
            <tbody>
              {rows && rows.length === 0 && <tr><td colSpan={3} className="sub">No sign-ups yet. Share ecomhubops.com to start the list.</td></tr>}
              {(rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.email}</td>
                  <td>{r.stores ?? "—"}</td>
                  <td className="sub">{new Date(r.created_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
