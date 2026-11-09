import { useCallback, useEffect, useState } from "react";
import { callFn, supabase } from "./supabase";

type Change = { id: string; store_key: string; summary: string; created_at: string; source: string; status: string };
type Audit = { at: string; store_key: string; actor: string; action: string; summary: string; status: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Changes({ onCount }: { onCount: (n: number) => void }) {
  const [pending, setPending] = useState<Change[]>([]);
  const [log, setLog] = useState<Audit[]>([]);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [p, a] = await Promise.all([
      supabase.from("pending_changes").select("id,store_key,summary,created_at,source,status").eq("status", "pending").gt("created_at", since).order("created_at", { ascending: false }),
      supabase.from("audit_log").select("at,store_key,actor,action,summary,status").order("at", { ascending: false }).limit(50),
    ]);
    setPending(p.data ?? []); setLog(a.data ?? []); onCount((p.data ?? []).length);
  }, [onCount]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(id);
    try { const r = await callFn<{ ok: boolean; message: string }>("changes", { id, action }); setMsg((m) => ({ ...m, [id]: r.message })); }
    catch (e) { setMsg((m) => ({ ...m, [id]: (e as Error).message })); }
    setBusy(""); load();
  };

  return (
    <>
      <div><div className="eyebrow">// APPROVALS</div><h1>Changes awaiting you</h1></div>
      <section className="panel warm" aria-label="Staged changes">
        {pending.length === 0 && <div className="sub">Nothing waiting. Claude stages changes here when a task needs your yes.</div>}
        {pending.map((c) => (
          <div className="list-item" key={c.id} style={{ flexWrap: "wrap" }}>
            <span className="mono" style={{ color: "#ffc24a" }}>{c.store_key.toUpperCase()}</span>
            <div style={{ flex: "1 1 300px", minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.summary}</div>
              <div className="sub">Staged {when(c.created_at)} by {c.source.replace(/^claude:/, "Claude for ")} · expires 24h after staging</div>
              {msg[c.id] && <div className="sub" role="status">{msg[c.id]}</div>}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn gold" disabled={busy === c.id} onClick={() => decide(c.id, "approve")}>APPROVE</button>
              <button className="btn" disabled={busy === c.id} onClick={() => decide(c.id, "reject")}>REJECT</button>
            </div>
          </div>
        ))}
        {Object.entries(msg).filter(([id]) => !pending.some((p) => p.id === id)).map(([id, m]) => <div key={id} className="sub" role="status">{m}</div>)}
      </section>

      <section className="panel" aria-label="Change log">
        <h2 style={{ color: "#38d6ff", marginBottom: 8 }}>CHANGE LOG</h2>
        <div className="scroll-x">
          <table>
            <thead><tr><th>WHEN</th><th>STORE</th><th>WHAT</th><th>BY</th><th>RESULT</th></tr></thead>
            <tbody>
              {log.length === 0 && <tr><td colSpan={5} className="sub">No changes yet.</td></tr>}
              {log.map((l, i) => (
                <tr key={i}>
                  <td className="mono">{when(l.at)}</td><td className="mono">{l.store_key?.toUpperCase()}</td><td>{l.summary}</td>
                  <td className="sub">{l.actor}</td>
                  <td style={{ color: l.status === "applied" ? "#3ee08f" : l.status === "failed" ? "#ff8b78" : "#9fc3d6" }}>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
