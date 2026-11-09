import { useCallback, useEffect, useMemo, useState } from "react";
import { callFn, supabase } from "./supabase";

type Ticket = {
  id: string; store_key: string; status: string; subject: string; customer_name: string | null; customer_email: string | null;
  category: string | null; order_ref: string | null; snippet: string | null; last_message_at: string; last_from_customer: boolean;
  unread: boolean; in_spam: boolean; draft_body: string | null; draft_reason: string | null; note: string | null; priority: number;
};
type Msg = { id: string; direction: "in" | "out"; from_addr: string; to_addr: string; sent_at: string; body_text: string };
type Sync = { store_key: string; mailbox: string; last_sync_at: string | null; ok: boolean | null; detail: string | null };

const FILTERS = [
  { k: "open", label: "OPEN", st: ["new", "needs_you", "awaiting_approval"] },
  { k: "awaiting_approval", label: "APPROVE", st: ["awaiting_approval"] },
  { k: "needs_you", label: "NEEDS YOU", st: ["needs_you"] },
  { k: "new", label: "NEW", st: ["new"] },
  { k: "replied", label: "REPLIED", st: ["replied"] },
  { k: "done", label: "DONE", st: ["done"] },
];
const STATUS: Record<string, { label: string; col: string }> = {
  new: { label: "NEW", col: "#38d6ff" },
  needs_you: { label: "NEEDS YOU", col: "#ff5d47" },
  awaiting_approval: { label: "APPROVE", col: "#ffc24a" },
  replied: { label: "REPLIED", col: "#3ee08f" },
  done: { label: "DONE", col: "#7fa9bf" },
};
const STORE_NAME: Record<string, string> = { cmp: "Cover My Plate", mvp: "My MVP Card", arca: "Arca Gear" };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export default function Inbox({ onCount }: { onCount: (n: number) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sync, setSync] = useState<Sync[]>([]);
  const [filter, setFilter] = useState("open");
  const [store, setStore] = useState("all");
  const [showSystem, setShowSystem] = useState(false);
  const [systemCount, setSystemCount] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const st = FILTERS.find((f) => f.k === filter)!.st;
    let q = supabase.from("tickets").select("*").in("status", st).order("priority").order("last_message_at", { ascending: false }).limit(300);
    if (store !== "all") q = q.eq("store_key", store);
    if (!showSystem) q = q.or("category.is.null,category.neq.notification");
    let sq = supabase.from("tickets").select("id", { count: "exact", head: true }).eq("category", "notification").in("status", st);
    if (store !== "all") sq = sq.eq("store_key", store);
    const [{ data }, { data: s }, { count }, { count: sys }] = await Promise.all([
      q, supabase.from("gmail_sync_state").select("*"),
      supabase.from("tickets").select("id", { count: "exact", head: true }).in("status", ["needs_you", "awaiting_approval"]),
      sq,
    ]);
    setTickets(data ?? []); setSync(s ?? []); onCount(count ?? 0); setSystemCount(sys ?? 0);
  }, [filter, store, showSystem, onCount]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const cur = useMemo(() => tickets.find((t) => t.id === sel) ?? null, [tickets, sel]);
  useEffect(() => {
    if (!sel) return;
    supabase.from("ticket_messages").select("id,direction,from_addr,to_addr,sent_at,body_text").eq("ticket_id", sel).order("sent_at").then(({ data }) => setMsgs(data ?? []));
  }, [sel, cur?.last_message_at]);
  useEffect(() => { setDraft(cur?.draft_body ?? ""); setMsg(""); }, [cur?.id, cur?.draft_body]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!cur) return;
    setBusy(action); setMsg("");
    try {
      const r: any = await callFn("inbox", { action, ticket_id: cur.id, ...extra });
      setMsg(action === "send" ? `Sent to ${r.to}.` : action === "done" ? "Filed as Completed." : "Saved.");
      await load();
    } catch (e) { setMsg((e as Error).message); }
    setBusy("");
  };
  const syncNow = async () => {
    setBusy("sync"); setMsg("");
    try { await callFn("gmail-sync", {}); } catch (e) { setMsg((e as Error).message); }
    await load(); setBusy("");
  };

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// SUPPORT INBOX · ALL STORES</div><h1>Support inbox</h1></div>
        <button className="btn primary" onClick={syncNow} disabled={busy === "sync"}>{busy === "sync" ? "SYNCING…" : "SYNC NOW"}</button>
      </div>

      <section className="grid" aria-label="Mailbox connections">
        {["cmp", "arca", "mvp"].map((k) => {
          const s = sync.find((x) => x.store_key === k);
          const col = !s?.last_sync_at ? "#7fa9bf" : s.ok ? "#3ee08f" : "#ff5d47";
          return (
            <div className="panel" key={k}>
              <div className="store-head"><span className="dot" style={{ width: 9, height: 9, background: col, boxShadow: `0 0 8px ${col}` }} /><span className="name">{STORE_NAME[k]}</span></div>
              <div className="sub mono">{s?.mailbox ?? "—"}</div>
              <div className="sub" style={{ color: s?.ok === false ? "#ff8b78" : undefined }}>
                {!s?.last_sync_at ? "Waiting for Google access" : s.ok ? `Synced ${ago(s.last_sync_at)} ago` : s.detail}
              </div>
            </div>
          );
        })}
      </section>

      <div className="row" role="toolbar" aria-label="Filters" style={{ flexWrap: "wrap" }}>
        {FILTERS.map((f) => <button key={f.k} className={`btn chip ${filter === f.k ? "on" : ""}`} onClick={() => { setFilter(f.k); setSel(null); }}>{f.label}</button>)}
        <button className={`btn chip ${showSystem ? "on" : ""}`} onClick={() => setShowSystem(!showSystem)} aria-pressed={showSystem}>SYSTEM MAIL {systemCount ? `(${systemCount})` : ""}</button>
        <span className="spacer" />
        {["all", "cmp", "arca", "mvp"].map((k) => <button key={k} className={`btn chip ${store === k ? "on" : ""}`} onClick={() => { setStore(k); setSel(null); }}>{k === "all" ? "ALL STORES" : k.toUpperCase()}</button>)}
      </div>

      <div className="inbox">
        <section className="panel inbox-list" aria-label="Tickets">
          {tickets.length === 0 && <div className="sub">Nothing here.</div>}
          {tickets.map((t) => {
            const st = STATUS[t.status];
            return (
              <button key={t.id} className={`ticket ${sel === t.id ? "on" : ""}`} onClick={() => setSel(t.id)}>
                <div className="between" style={{ gap: 8 }}>
                  <span className="tag" style={{ color: st.col, borderColor: st.col }}>{st.label}</span>
                  <span className="sub mono">{t.store_key.toUpperCase()} · {ago(t.last_message_at)}</span>
                </div>
                <div className={`t-from ${t.unread ? "unread" : ""}`}>{t.customer_name || t.customer_email}{t.in_spam ? " · SPAM" : ""}{t.category === "sms" ? " · TEXT" : ""}{t.category === "notification" ? " · SYSTEM" : ""}</div>
                <div className="t-subj">{t.subject}{t.order_ref ? ` · #${t.order_ref}` : ""}</div>
                <div className="sub t-snip">{t.note || t.draft_reason || t.snippet}</div>
              </button>
            );
          })}
        </section>

        <section className="panel inbox-thread" aria-label="Thread">
          {!cur && <div className="sub">Pick a ticket.</div>}
          {cur && (
            <>
              <div className="eyebrow">{STORE_NAME[cur.store_key] ?? cur.store_key} · {cur.customer_email}</div>
              <h2 style={{ margin: "4px 0 12px" }}>{cur.subject}</h2>
              {cur.note && <div className="panel hot" style={{ marginBottom: 12 }}><div className="label">FLAGGED</div>{cur.note}</div>}
              <div className="msgs">
                {msgs.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`}>
                    <div className="sub mono">{m.direction === "in" ? m.from_addr : "You"} · {new Date(m.sent_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                    <div className="msg-body">{m.body_text}</div>
                  </div>
                ))}
              </div>
              {cur.status !== "done" && (
                <div className="reply">
                  {cur.draft_reason && <div className="panel warm" style={{ marginBottom: 10 }}><div className="label">WHY THIS NEEDS YOU</div>{cur.draft_reason}</div>}
                  <Blanks draft={draft} setDraft={setDraft} />
                  <label className="field"><span className="label">REPLY {cur.draft_body ? "(DRAFT BY CLAUDE — EDIT FREELY)" : ""}</span>
                    <textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply…"
                      style={findBlanks(draft).length ? { borderColor: "#ff5d47", boxShadow: "0 0 0 1px #ff5d47" } : undefined} />
                  </label>
                  {findBlanks(draft).length > 0 && <Preview draft={draft} />}
                  <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
                    <button className="btn gold" disabled={!!busy || draft.trim().length < 2 || findBlanks(draft).length > 0} onClick={() => act("send", { body: draft })}>
                      {busy === "send" ? "SENDING…" : findBlanks(draft).length ? `FILL ${findBlanks(draft).length} BLANK${findBlanks(draft).length > 1 ? "S" : ""} FIRST` : "APPROVE & SEND"}
                    </button>
                    <button className="btn" disabled={!!busy} onClick={() => act("save_draft", { body: draft })}>SAVE DRAFT</button>
                    {cur.draft_body && <button className="btn" disabled={!!busy} onClick={() => act("discard_draft")}>DISCARD DRAFT</button>}
                    <span className="spacer" />
                    <button className="btn" disabled={!!busy} onClick={() => act("done")}>FILE AS DONE</button>
                  </div>
                </div>
              )}
              {cur.status === "done" && <button className="btn" onClick={() => act("reopen")}>REOPEN</button>}
              {msg && <div className="sub" role="status" style={{ marginTop: 8 }}>{msg}</div>}
            </>
          )}
        </section>
      </div>
    </>
  );
}

// ---------- Blanks Claude leaves in drafts ----------
// [[CHOOSE: option A || option B]] -> one-tap buttons; [[ADD: ship date]] -> a field. Old style [ADD ...] / [CHOOSE ONE: a / b] too.
const BLANK_RE = /\[\[[^\]]+\]\]|\[(?:ADD|CHOOSE|INSERT|FILL|TBD|PICK)\b[^\]]*\]/gi;
export const findBlanks = (s: string) => s.match(BLANK_RE) ?? [];
function parseBlank(raw: string): { kind: "choose" | "add"; label: string; options: string[] } {
  const inner = raw.replace(/^\[\[?|\]\]?$/g, "").trim();
  const m = inner.match(/^(CHOOSE(?: ONE)?|PICK(?: ONE)?)\s*:?\s*([\s\S]*)$/i);
  if (m) {
    const parts = m[2].split(/\s*\|\|\s*|\s+\/\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) return { kind: "choose", label: "Pick one", options: parts };
  }
  return { kind: "add", label: inner.replace(/^(ADD|INSERT|FILL|TBD)\s*:?\s*/i, "") || "Fill this in", options: [] };
}

function Blanks({ draft, setDraft }: { draft: string; setDraft: (s: string) => void }) {
  const blanks = findBlanks(draft);
  const [vals, setVals] = useState<Record<string, string>>({});
  if (!blanks.length) return null;
  const fill = (raw: string, text: string) => { if (text.trim()) setDraft(draft.replace(raw, text.trim())); };
  return (
    <div className="panel hot" style={{ marginBottom: 10 }} role="alert">
      <div className="label" style={{ color: "#ff5d47" }}>FILL {blanks.length} BLANK{blanks.length > 1 ? "S" : ""} BEFORE SENDING</div>
      {blanks.map((raw, i) => {
        const b = parseBlank(raw);
        return (
          <div key={raw + i} style={{ marginTop: 10 }}>
            <div className="sub" style={{ color: "#ff8b78" }}>{b.kind === "choose" ? "Pick one:" : `Add: ${b.label}`}</div>
            {b.kind === "choose" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                {b.options.map((o) => <button key={o} className="btn" style={{ textAlign: "left", whiteSpace: "normal" }} onClick={() => fill(raw, o)}>{o}</button>)}
              </div>
            ) : (
              <form className="row" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); fill(raw, vals[raw] ?? ""); }}>
                <input style={{ flex: 1, padding: "9px 10px", borderRadius: 6, border: "1px solid #ff5d47", background: "rgba(255,93,71,0.06)", color: "inherit", font: "inherit" }}
                  placeholder={b.label} value={vals[raw] ?? ""} onChange={(e) => setVals({ ...vals, [raw]: e.target.value })} aria-label={b.label} />
                <button className="btn gold" disabled={!(vals[raw] ?? "").trim()}>USE</button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Preview({ draft }: { draft: string }) {
  const parts: (string | { blank: string })[] = [];
  let last = 0;
  for (const m of draft.matchAll(BLANK_RE)) {
    parts.push(draft.slice(last, m.index));
    parts.push({ blank: m[0] });
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(draft.slice(last));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="label">PREVIEW</div>
      <div className="msg-body" style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
        {parts.map((p, i) => typeof p === "string" ? <span key={i}>{p}</span>
          : <mark key={i} style={{ background: "rgba(255,93,71,0.2)", color: "#ff5d47", fontWeight: 700, borderRadius: 3, padding: "0 2px" }}>{p.blank}</mark>)}
      </div>
    </div>
  );
}
