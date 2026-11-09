import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

type PB = { store_key: string; signer: string; voice: string; auto_send: string; needs_approval: string; policies: string; notes: string; version: number; updated_by: string | null; updated_at: string };
type Field = "signer" | "voice" | "auto_send" | "needs_approval" | "policies" | "notes";
const SECTIONS: { k: Field; label: string; hint: string; rows: number }[] = [
  { k: "signer", label: "SIGNED AS", hint: "Name at the bottom of every reply.", rows: 1 },
  { k: "voice", label: "VOICE", hint: "How this store sounds.", rows: 4 },
  { k: "auto_send", label: "SEND WITHOUT ASKING", hint: "Routine replies Claude may send on its own.", rows: 8 },
  { k: "needs_approval", label: "ALWAYS ASK ME", hint: "Claude drafts these for your approval, or flags them.", rows: 5 },
  { k: "policies", label: "POLICIES", hint: "Facts Claude may quote to customers.", rows: 10 },
  { k: "notes", label: "NOTES", hint: "Background for Claude; never quoted to customers.", rows: 3 },
];
const NAMES: Record<string, string> = { cmp: "Cover My Plate", arca: "Arca Gear", mvp: "My MVP Card" };
const FIELDS = SECTIONS.map((s) => s.k);

export default function Playbooks() {
  const [saved, setSaved] = useState<Record<string, PB>>({});
  // Unsaved edits per store survive switching tabs.
  const [edits, setEdits] = useState<Record<string, Partial<Record<Field, string>>>>({});
  const [key, setKey] = useState("cmp");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = async () => {
    const { data, error } = await supabase.from("store_playbooks").select("*");
    if (error) { setMsg({ text: `Couldn't load playbooks: ${error.message}`, bad: true }); return; }
    setSaved(Object.fromEntries((data ?? []).map((p: PB) => [p.store_key, p])));
  };
  useEffect(() => { load(); }, []);

  const dirtyKeys = useMemo(() => Object.keys(edits).filter((k) => {
    const e = edits[k], s = saved[k];
    return s && e && FIELDS.some((f) => e[f] !== undefined && e[f] !== s[f]);
  }), [edits, saved]);
  const dirty = dirtyKeys.length > 0;

  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => { if (dirty) { ev.preventDefault(); ev.returnValue = ""; } };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const value = (f: Field) => edits[key]?.[f] ?? saved[key]?.[f] ?? "";
  const set = (f: Field, v: string) => { setMsg(null); setEdits((e) => ({ ...e, [key]: { ...e[key], [f]: v } })); };

  const saveAll = async () => {
    setBusy(true); setMsg(null);
    const { data: u } = await supabase.auth.getSession();
    const by = `hub:${u.session?.user.email ?? ""}`;
    const done: string[] = [];
    for (const k of dirtyKeys) {
      const s = saved[k], e = edits[k];
      const patch: Record<string, unknown> = { version: s.version + 1, updated_by: by, updated_at: new Date().toISOString() };
      for (const f of FIELDS) if (e[f] !== undefined) patch[f] = e[f];
      const { data, error } = await supabase.from("store_playbooks").update(patch).eq("store_key", k).select("store_key");
      if (error || !data?.length) {
        setMsg({ text: `${NAMES[k]} didn't save: ${error?.message ?? "the Hub refused the change (are you still signed in?)"}. Your edits are still here.`, bad: true });
        setBusy(false); await load(); return;
      }
      done.push(NAMES[k]);
    }
    setEdits({});
    await load();
    setBusy(false);
    setMsg({ text: `Saved ${done.join(" and ")}. Claude uses it on the next ticket.` });
  };

  const s = saved[key];
  const SaveBtn = () => (
    <button className="btn primary" onClick={saveAll} disabled={!dirty || busy}>
      {busy ? "SAVING…" : dirty ? `SAVE CHANGES (${dirtyKeys.length})` : "SAVED"}
    </button>
  );

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// SUPPORT PLAYBOOKS · ONE PER COMPANY</div><h1>Playbooks</h1></div>
        <SaveBtn />
      </div>
      <div className="row" role="tablist">
        {["cmp", "arca", "mvp"].map((k) => (
          <button key={k} role="tab" aria-selected={key === k} className={`btn chip ${key === k ? "on" : ""}`} onClick={() => setKey(k)}>
            {NAMES[k]}{dirtyKeys.includes(k) ? " •" : ""}
          </button>
        ))}
      </div>
      {msg && <div className={msg.bad ? "panel hot" : "sub"} role="status">{msg.text}</div>}
      {dirty && !msg && <div className="sub" role="status" style={{ color: "#ffc24a" }}>Unsaved changes in {dirtyKeys.map((k) => NAMES[k]).join(", ")} — hit Save.</div>}
      {s && (
        <section className="panel" aria-label={`${NAMES[key]} playbook`}>
          <div className="sub">Version {s.version} · last saved {new Date(s.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" })}{s.updated_by ? ` by ${s.updated_by}` : ""}</div>
          {SECTIONS.map((sec) => (
            <label className="field" key={sec.k} style={{ marginTop: 14 }}>
              <span className="label">{sec.label}</span>
              <span className="sub">{sec.hint}</span>
              {sec.rows === 1
                ? <input value={value(sec.k)} onChange={(e) => set(sec.k, e.target.value)} />
                : <textarea rows={sec.rows} value={value(sec.k)} onChange={(e) => set(sec.k, e.target.value)} />}
            </label>
          ))}
          <div className="row" style={{ marginTop: 16 }}><SaveBtn /></div>
        </section>
      )}
    </>
  );
}
