import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import Overview from "./Overview";
import Stores from "./Stores";
import Changes from "./Changes";
import Waitlist from "./Waitlist";

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function usePath() {
  const [p, setP] = useState(location.pathname);
  useEffect(() => {
    const on = () => setP(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return p;
}

export function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 34 34" aria-hidden="true">
      <polygon points="17,2 30,9.5 30,24.5 17,32 4,24.5 4,9.5" fill="none" stroke="#38d6ff" strokeWidth="1.5" />
      <polygon points="17,9 23.5,12.75 23.5,21.25 17,25 10.5,21.25 10.5,12.75" fill="rgba(56,214,255,0.18)" stroke="#38d6ff" strokeWidth="1" />
      <circle cx="17" cy="17" r="2.6" fill="#ffc24a" />
    </svg>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  const s = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return <div className="clock">{s.toUpperCase()} ET</div>;
}

function Top({ session, right }: { session: Session | null; right?: ReactNode }) {
  return (
    <header className="top">
      <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}><Logo />ECOM HUB OPS</a>
      {right}
      <div className="spacer" />
      <Clock />
      {session && (
        <button className="btn chip" onClick={() => supabase.auth.signOut().then(() => navigate("/login"))}>SIGN OUT</button>
      )}
    </header>
  );
}

const NAV = [
  { path: "/", label: "Overview" },
  { path: "/changes", label: "Approvals" },
  { path: "/stores", label: "Stores" },
  { path: "/waitlist", label: "Waitlist" },
  { path: "#", label: "Support inbox", soon: "PHASE 2" },
  { path: "#", label: "Reviews", soon: "PHASE 3" },
  { path: "#", label: "Custom hubs", soon: "PHASE 4" },
];

function Shell({ path, session, children, pending, waitlist }: { path: string; session: Session; children: ReactNode; pending: number; waitlist: number }) {
  return (
    <>
      <div className="scan" aria-hidden="true" />
      <Top session={session} right={<div className="status"><span className="dot pulse" style={{ background: "#3ee08f", boxShadow: "0 0 8px #3ee08f" }} />LIVE</div>} />
      <div className="layout">
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.label} href={n.path} className={`${path === n.path ? "on" : ""} ${n.soon ? "soon" : ""}`}
              aria-current={path === n.path ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); if (!n.soon) navigate(n.path); }}>
              <span className="tick" />{n.label}
              <span className="badge">{n.soon ?? (n.path === "/changes" && pending ? pending : n.path === "/waitlist" && waitlist ? waitlist : "")}</span>
            </a>
          ))}
        </nav>
        <main className="main">{children}</main>
      </div>
    </>
  );
}

function Login({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Top session={null} />
      <div className="center">
        <form className="panel card" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr("");
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          setBusy(false);
          if (error) setErr(error.message); else navigate(next);
        }}>
          <div><div className="eyebrow">// AUTHENTICATE</div><h1>Sign in</h1></div>
          <label className="field"><span className="label">EMAIL</span><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field"><span className="label">PASSWORD</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {err && <div className="err" role="alert">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? "SIGNING IN…" : "SIGN IN"}</button>
        </form>
      </div>
    </>
  );
}

// Supabase OAuth 2.1 authorization page: claude.ai (or another MCP client) lands here to get access.
function Consent({ session }: { session: Session }) {
  const id = new URLSearchParams(location.search).get("authorization_id") ?? "";
  const [details, setDetails] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!id) { setErr("Missing authorization request."); return; }
    (supabase.auth as any).oauth.getAuthorizationDetails(id).then(({ data, error }: any) => {
      if (error) return setErr(error.message);
      if (data && !("authorization_id" in data) && data.redirect_url) { location.href = data.redirect_url; return; }
      setDetails(data);
    });
  }, [id]);
  const decide = async (approve: boolean) => {
    setBusy(true);
    const oauth = (supabase.auth as any).oauth;
    const { data, error } = approve ? await oauth.approveAuthorization(id) : await oauth.denyAuthorization(id);
    if (error) { setErr(error.message); setBusy(false); return; }
    location.href = data.redirect_url ?? data.redirect_to;
  };
  return (
    <>
      <Top session={session} />
      <div className="center">
        <div className="panel warm card">
          <div><div className="eyebrow">// ACCESS REQUEST</div><h1>Allow access?</h1></div>
          {err && <div className="err" role="alert">{err}</div>}
          {details && (
            <>
              <p style={{ margin: 0 }}><strong>{details.client?.name ?? details.client?.client_name ?? "An app"}</strong> wants to use Ecom Hub Ops as <strong>{session.user.email}</strong>.</p>
              <p className="sub" style={{ margin: 0 }}>It will be able to read all connected stores and stage changes. Changes still need approval, or a task you set up that pre-approves them. You can cut access anytime from the Stores page.</p>
              <p className="sub mono" style={{ margin: 0, wordBreak: "break-all" }}>Returns to: {details.redirect_uri ?? details.client?.redirect_uri ?? "—"}</p>
              <div className="row">
                <button className="btn gold" disabled={busy} onClick={() => decide(true)}>ALLOW</button>
                <button className="btn" disabled={busy} onClick={() => decide(false)}>DENY</button>
              </div>
            </>
          )}
          {!details && !err && <div className="sub">Loading request…</div>}
        </div>
      </div>
    </>
  );
}

export default function App() {
  const path = usePath();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const [waitlist, setWaitlist] = useState(0);
  useEffect(() => {
    if (!session) return;
    supabase.from("waitlist").select("id", { count: "exact", head: true }).then(({ count }) => setWaitlist(count ?? 0));
  }, [session]);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  const here = location.pathname + location.search;
  if (path === "/login") return <Login next={new URLSearchParams(location.search).get("next") ?? "/"} />;
  if (!session) { navigate(`/login?next=${encodeURIComponent(here)}`); return null; }
  if (path === "/oauth/consent") return <Consent session={session} />;

  return (
    <Shell path={path} session={session} pending={pending} waitlist={waitlist}>
      {path === "/stores" ? <Stores /> : path === "/waitlist" ? <Waitlist onCount={setWaitlist} /> : path === "/changes" ? <Changes onCount={setPending} /> : <Overview onPending={setPending} />}
    </Shell>
  );
}
