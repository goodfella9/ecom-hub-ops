import { useEffect, useState } from "react";
import { supabase } from "./supabase";

type PB = { store_key: string; signer: string; voice: string; auto_send: string; needs_approval: string; policies: string; notes: string; version: number; updated_by: string | null; updated_at: string };
const SECTIONS: { k: keyof PB; label: string; hint: string; rows: number }[] = [
  { k: "signer", label: "SIGNED AS", hint: "Name at the bottom of every reply.", rows: 1 },
  { k: "voice", label: "VOICE", hint: "How this store sounds.", rows: 4 },
  { k: "auto_send", label: "SEND WITHOUT ASKING", hint: "Routine replies Claude may send on its own.", rows: 8 },
  { k: "needs_approval", label: "ALWAYS ASK ME", hint: "Claude drafts these for your approval, or flags them.", rows: 5 },
  { k: "policies", label: "POLICIES", hint: "Facts Claude may quote to customers.", rows: 10 },
  { k: "notes", label: "NOTES", hint: "Background for Claude; never quoted to customers.", rows: 3 },
];
const NAMES: Record<string, string> = { cmp: "Cover My Plate", arca: "Arca Gear", mvp: "My MVP Card" };

export default function Playbooks() {
  const [all, setAll] = useState<PB[]>([]);
  const [key, setKey] = useState("cmp");
  const [form, setForm] = useState<PB | null>(null);
  const [msg, setMsg] = useState("");

  const load = async () => {
    const { data } = await supabase.from("store_playbooks").select("*");
    setAll(data ?? []);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { setForm(all.find((p) => p.store_key === key) ?? null); setMsg(""); }, [all, key]);

  const save = async () => {
    if (!form) return;
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("store_playbooks").update({
      signer: form.signer, voice: form.voice, auto_send: form.auto_send, needs_approval: form.needs_approval, policies: form.policies, notes: form.notes,
      version: form.version + 1, updated_by: `hub:${u.user?.email ?? ""}`, updated_at: new Date().toISOString(),
    }).eq("store_key", form.store_key);
    setMsg(error ? error.message : "Saved. Claude uses it on the next ticket.");
    load();
  };

  return (
    <>
      <div className="between">
        <div><div className="eyebrow">// SUPPORT PLAYBOOKS · ONE PER COMPANY</div><h1>Playbooks</h1></div>
        <button className="btn primary" onClick={save} disabled={!form}>SAVE</button>
      </div>
      <div className="row" role="tablist">
        {["cmp", "arca", "mvp"].map((k) => <button key={k} role="tab" aria-selected={key === k} className={`btn chip ${key === k ? "on" : ""}`} onClick={() => setKey(k)}>{NAMES[k]}</button>)}
      </div>
      {msg && <div className="sub" role="status">{msg}</div>}
      {form && (
        <section className="panel" aria-label={`${NAMES[key]} playbook`}>
          <div className="sub">Version {form.version} · last edited {new Date(form.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" })}{form.updated_by ? ` by ${form.updated_by}` : ""}</div>
          {SECTIONS.map((s) => (
            <label className="field" key={s.k} style={{ marginTop: 14 }}>
              <span className="label">{s.label}</span>
              <span className="sub">{s.hint}</span>
              {s.rows === 1
                ? <input value={String(form[s.k] ?? "")} onChange={(e) => setForm({ ...form, [s.k]: e.target.value })} />
                : <textarea rows={s.rows} value={String(form[s.k] ?? "")} onChange={(e) => setForm({ ...form, [s.k]: e.target.value })} />}
            </label>
          ))}
        </section>
      )}
    </>
  );
}
