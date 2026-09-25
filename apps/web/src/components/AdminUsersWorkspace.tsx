"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { AUDIT_ACTION_COPY, ERROR_COPY, PERMISSION_COPY, STATUS_COPY, type Copy } from "@/lib/access-copy";

export interface RoleSummary {
  readonly id: string; readonly name: string; readonly description: string; readonly status: "ACTIVE" | "INACTIVE";
  readonly version: number; readonly permissions: readonly string[];
  readonly holders: readonly { readonly id: string; readonly displayName: string; readonly status: string }[]; readonly youHoldThis: boolean;
}
interface UserSummary {
  readonly id: string; readonly loginIdentifier: string; readonly displayName: string; readonly jobTitle: string | null;
  readonly contactEmail: string | null; readonly contactPhone: string | null; readonly status: "ACTIVE" | "DISABLED" | "INVITED" | "REVOKED";
  readonly canSignIn: boolean; readonly mustChangePassword: boolean; readonly roles: readonly { readonly id: string; readonly name: string }[];
  readonly permissions: readonly string[]; readonly activeSessions: number; readonly isYou: boolean; readonly createdAt: string;
}
interface AuditEntry { readonly id: string; readonly occurredAt: string; readonly action: string; readonly actor: string; readonly target: string; readonly entityType: string }
interface UserDetail extends UserSummary {
  readonly effectivePermissions: readonly { readonly code: string; readonly viaRoles: readonly string[] }[];
  readonly recentActivity: readonly AuditEntry[];
}
type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: { code: string; message: string } };

export async function api<T>(url: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
    const parsed = await response.json() as { ok: boolean; data?: T; error?: { code: string; message: string } };
    return parsed.ok ? { ok: true, data: parsed.data as T } : { ok: false, status: response.status, error: parsed.error ?? { code: "INTERNAL_ERROR", message: "Unexpected response" } };
  } catch {
    return { ok: false, status: 0, error: { code: "NETWORK", message: "The server could not be reached." } };
  }
}

export function errorText(error: { code: string; message: string }, locale: "en" | "fa"): string {
  const copy = ERROR_COPY[error.code];
  return copy ? copy[locale] : error.message;
}

export function formatWhen(value: string, locale: "en" | "fa"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "fa" ? "fa-AF" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kabul" }).format(date);
}

export function AccessGate({ state, fa, what }: { readonly state: "signed-out" | "denied"; readonly fa: boolean; readonly what: Copy }) {
  return (
    <div className="treasury-card access-denied" role="status">
      <AppIcon name="shield" size={26} />
      {state === "signed-out" ? <>
        <h2>{fa ? "ابتدا وارد شوید" : "Sign in first"}</h2>
        <p>{fa ? "این بخش فقط برای کارمندان واردشده است." : "This area is only for signed-in employees."}</p>
        <Link className="treasury-button gold" href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/dashboard" : window.location.pathname)}`}>{fa ? "ورود" : "Sign in"}</Link>
      </> : <>
        <h2>{fa ? "دسترسی ندارید" : "You do not have access"}</h2>
        <p>{fa ? what.fa : what.en}</p>
        <p className="access-denied-note">{fa ? "سرور این درخواست را رد کرد. اگر فکر می‌کنید به این بخش نیاز دارید، از مدیر ارشد بخواهید نقش مناسب را به شما بدهد." : "The server refused this request. If you need this area, ask a Super Administrator to give you a suitable role."}</p>
      </>}
    </div>
  );
}

export function AdminUsersWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const session = useSession();
  const [users, setUsers] = useState<readonly UserSummary[] | null>(null);
  const [roles, setRoles] = useState<readonly RoleSummary[]>([]);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<{ name: string; login: string; password: string } | null>(null);
  const [tab, setTab] = useState<"people" | "history">("people");
  const [history, setHistory] = useState<readonly AuditEntry[]>([]);
  const [filter, setFilter] = useState("");

  const applyList = useCallback((result: ApiResult<readonly UserSummary[]>) => {
    if (result.ok) { setUsers(result.data); setGate(null); return; }
    setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
    if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
  }, [locale]);
  const reload = useCallback(async () => {
    applyList(await api<readonly UserSummary[]>("/api/v1/admin/users"));
    const roleResult = await api<readonly RoleSummary[]>("/api/v1/admin/roles");
    if (roleResult.ok) setRoles(roleResult.data);
  }, [applyList]);

  useEffect(() => {
    let current = true;
    void api<readonly UserSummary[]>("/api/v1/admin/users").then((result) => { if (current) applyList(result); });
    void api<readonly RoleSummary[]>("/api/v1/admin/roles").then((result) => { if (current && result.ok) setRoles(result.data); });
    return () => { current = false; };
  }, [applyList]);

  useEffect(() => {
    let current = true;
    if (tab === "history") void api<readonly AuditEntry[]>("/api/v1/admin/audit").then((result) => { if (current && result.ok) setHistory(result.data); });
    return () => { current = false; };
  }, [tab]);

  const open = async (id: string) => {
    setSelected(id); setSecret(null); setMessage(null);
    const result = await api<UserDetail>(`/api/v1/admin/users/${id}`);
    if (result.ok) setDetail(result.data); else setMessage({ tone: "error", text: errorText(result.error, locale) });
  };

  const afterChange = async (result: ApiResult<UserDetail>, success: Copy) => {
    if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
    setDetail(result.data); setMessage({ tone: "ok", text: t(success) });
    await reload();
    if (result.data.isYou) await session.refresh();
  };

  const visible = useMemo(() => (users ?? []).filter((user) => {
    const needle = filter.trim().toLowerCase();
    return !needle || user.displayName.toLowerCase().includes(needle) || user.loginIdentifier.includes(needle) || (user.jobTitle ?? "").toLowerCase().includes(needle);
  }), [filter, users]);

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Managing employee accounts needs the “Manage employee accounts” permission.", fa: "مدیریت حساب‌های کارمندان به صلاحیت «مدیریت حساب‌های کارمندان» نیاز دارد." }} /></div>;

  return (
    <div className="module-workspace admin-workspace">
      <StageZeroPageHeader icon="human-resources"
        eyebrow={{ en: "Administration · V1 client preview", fa: "مدیریت · پیش‌نمایش مشتری V1" }}
        title={{ en: "Users", fa: "کاربران" }}
        description={{ en: "Employee accounts, their roles and what those roles allow. Every change is recorded.", fa: "حساب‌های کارمندان، نقش‌ها و آنچه نقش‌ها اجازه می‌دهند. هر تغییر ثبت می‌شود." }}>
        <button type="button" className="treasury-button gold" onClick={() => { setSelected("new"); setDetail(null); setSecret(null); setMessage(null); setTab("people"); }}>
          <AppIcon name="human-resources" size={15} />{fa ? "کارمند جدید" : "New employee"}
        </button>
      </StageZeroPageHeader>

      <div className="admin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}>{fa ? "کارمندان" : "Employees"} <b>{users?.length ?? "…"}</b></button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>{fa ? "تاریخچه دسترسی" : "Access history"}</button>
      </div>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {secret ? (
        <section className="admin-secret" role="status" aria-live="polite">
          <AppIcon name="key" size={22} />
          <div>
            <strong>{fa ? `رمز موقت برای ${secret.name}` : `Temporary password for ${secret.name}`}</strong>
            <p>{fa ? "این رمز فقط یک بار نمایش داده می‌شود. آن را حضوری یا از راه امن به کارمند بدهید. کارمند هنگام نخستین ورود باید رمز خود را انتخاب کند." : "Shown once only. Give it to the employee in person or through a secure channel. They must choose their own password at first sign-in."}</p>
            <dl><div><dt>{fa ? "نام کاربری" : "Username"}</dt><dd dir="ltr">{secret.login}</dd></div><div><dt>{fa ? "رمز موقت" : "Temporary password"}</dt><dd dir="ltr" className="admin-secret-value">{secret.password}</dd></div></dl>
          </div>
          <button type="button" className="treasury-button quiet" onClick={() => setSecret(null)}>{fa ? "تحویل داده شد" : "Handed over"}</button>
        </section>
      ) : null}

      {tab === "history" ? <HistoryPanel entries={history} fa={fa} t={t} locale={locale} /> : (
        <section className="admin-grid">
          <div className="module-content-card admin-list">
            <label className="admin-search"><AppIcon name="search" size={15} /><span className="sr-only">{fa ? "جستجو" : "Search"}</span>
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={fa ? "جستجوی نام، نام کاربری یا وظیفه" : "Search name, username or job title"} /></label>
            {users === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : visible.map((user) => (
              <button key={user.id} type="button" className={selected === user.id ? "selected" : ""} onClick={() => void open(user.id)}>
                <span className="treasury-avatar" aria-hidden="true">{user.displayName.split(" ").map((part) => part[0]).slice(-2).join("")}</span>
                <span><strong>{user.displayName}{user.isYou ? <em className="admin-you">{fa ? "شما" : "You"}</em> : null}</strong>
                  <small dir="ltr">{user.loginIdentifier}</small>
                  <small>{user.roles.map((role) => role.name).join(" · ") || (fa ? "بدون نقش" : "No role")}</small></span>
                <StatusChip user={user} fa={fa} />
              </button>
            ))}
          </div>
          <div className="module-content-card admin-detail">
            {selected === "new" ? <CreateUser roles={roles} fa={fa} locale={locale} onCreated={async (created, password) => {
              setSecret({ name: created.displayName, login: created.loginIdentifier, password });
              setSelected(created.id); setDetail(created); setMessage({ tone: "ok", text: fa ? "حساب کارمند ایجاد شد." : "Employee account created." });
              await reload();
            }} onError={(text) => setMessage({ tone: "error", text })} />
              : detail ? <UserPanel key={detail.id} user={detail} roles={roles} fa={fa} locale={locale} t={t}
                onProfile={async (body) => afterChange(await api<UserDetail>(`/api/v1/admin/users/${detail.id}`, "PATCH", body), { en: "Details saved.", fa: "مشخصات ذخیره شد." })}
                onStatus={async (status) => afterChange(await api<UserDetail>(`/api/v1/admin/users/${detail.id}/status`, "POST", { status }),
                  status === "DISABLED" ? { en: "Account suspended and signed out everywhere.", fa: "حساب معلق شد و از همه جا خارج شد." } : { en: "Account reactivated.", fa: "حساب دوباره فعال شد." })}
                onRoles={async (roleIds) => afterChange(await api<UserDetail>(`/api/v1/admin/users/${detail.id}/roles`, "PUT", { roleIds }),
                  { en: "Roles saved. The employee was signed out so the new access applies at once.", fa: "نقش‌ها ذخیره شد. کارمند خارج شد تا دسترسی جدید فوراً اعمال شود." })}
                onSessions={async () => afterChange(await api<UserDetail>(`/api/v1/admin/users/${detail.id}/sessions`, "DELETE", {}), { en: "Signed out everywhere.", fa: "از همه جا خارج شد." })}
                onReset={async () => {
                  const result = await api<{ user: UserDetail; temporaryPassword: string }>(`/api/v1/admin/users/${detail.id}/password-reset`, "POST", {});
                  if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
                  setDetail(result.data.user); setSecret({ name: result.data.user.displayName, login: result.data.user.loginIdentifier, password: result.data.temporaryPassword });
                  setMessage({ tone: "ok", text: fa ? "رمز موقت صادر شد و همه نشست‌های کارمند پایان یافت." : "Temporary password issued; all of the employee’s sessions ended." });
                  await reload();
                }} />
                : <div className="treasury-placeholder"><AppIcon name="human-resources" size={24} /><p>{fa ? "یک کارمند را انتخاب کنید یا کارمند جدید ایجاد کنید." : "Choose an employee, or create a new one."}</p></div>}
          </div>
        </section>
      )}
    </div>
  );
}

function StatusChip({ user, fa }: { readonly user: UserSummary; readonly fa: boolean }) {
  if (user.status !== "ACTIVE") return <em className="treasury-chip danger">{fa ? STATUS_COPY[user.status]?.fa : STATUS_COPY[user.status]?.en}</em>;
  if (user.mustChangePassword) return <em className="treasury-chip gold">{fa ? "منتظر نخستین ورود" : "Awaiting first sign-in"}</em>;
  if (user.permissions.length === 0) return <em className="treasury-chip muted">{fa ? "بدون دسترسی" : "No access"}</em>;
  return <em className="treasury-chip ok">{fa ? "فعال" : "Active"}</em>;
}

interface ProfileBody { displayName: string; jobTitle: string; contactEmail: string; contactPhone: string }

function ProfileFields({ value, onChange, fa }: { readonly value: ProfileBody; readonly onChange: (next: ProfileBody) => void; readonly fa: boolean }) {
  return <>
    <label><span>{fa ? "نام کامل" : "Full name"}</span><input value={value.displayName} onChange={(event) => onChange({ ...value, displayName: event.target.value })} required minLength={2} maxLength={120} /></label>
    <label><span>{fa ? "وظیفه" : "Job title"}</span><input value={value.jobTitle} onChange={(event) => onChange({ ...value, jobTitle: event.target.value })} maxLength={120} /></label>
    <label><span>{fa ? "ایمیل (اختیاری)" : "Email (optional)"}</span><input type="email" dir="ltr" value={value.contactEmail} onChange={(event) => onChange({ ...value, contactEmail: event.target.value })} /></label>
    <label><span>{fa ? "تلفن (اختیاری)" : "Phone (optional)"}</span><input type="tel" dir="ltr" value={value.contactPhone} onChange={(event) => onChange({ ...value, contactPhone: event.target.value })} /></label>
  </>;
}

function RolePicker({ roles, chosen, onToggle, fa, disabled }: { readonly roles: readonly RoleSummary[]; readonly chosen: ReadonlySet<string>; readonly onToggle: (id: string) => void; readonly fa: boolean; readonly disabled?: boolean }) {
  const active = roles.filter((role) => role.status === "ACTIVE" || chosen.has(role.id));
  if (active.length === 0) return <p className="treasury-placeholder">{fa ? "هنوز نقشی وجود ندارد. ابتدا در «نقش‌ها و صلاحیت‌ها» نقش بسازید." : "There are no roles yet. Create one under “Roles & permissions” first."}</p>;
  return (
    <fieldset className="admin-role-picker" disabled={disabled}>
      {active.map((role) => (
        <label key={role.id} className={chosen.has(role.id) ? "chosen" : ""}>
          <input type="checkbox" checked={chosen.has(role.id)} onChange={() => onToggle(role.id)} />
          <span><strong>{role.name}{role.status === "INACTIVE" ? ` · ${fa ? "غیرفعال" : "inactive"}` : ""}</strong>
            <small>{role.permissions.length} {fa ? "صلاحیت" : role.permissions.length === 1 ? "permission" : "permissions"}{role.description ? ` · ${role.description}` : ""}</small></span>
        </label>
      ))}
    </fieldset>
  );
}

function CreateUser({ roles, fa, locale, onCreated, onError }: {
  readonly roles: readonly RoleSummary[]; readonly fa: boolean; readonly locale: "en" | "fa";
  readonly onCreated: (user: UserDetail, password: string) => Promise<void>; readonly onError: (text: string) => void;
}) {
  const [login, setLogin] = useState("");
  const [profile, setProfile] = useState<ProfileBody>({ displayName: "", jobTitle: "", contactEmail: "", contactPhone: "" });
  const [status, setStatus] = useState<"ACTIVE" | "DISABLED">("ACTIVE");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    const result = await api<{ user: UserDetail; temporaryPassword: string }>("/api/v1/admin/users", "POST", { loginIdentifier: login, ...profile, status, roleIds: [...chosen] });
    setBusy(false);
    if (!result.ok) { onError(errorText(result.error, locale)); return; }
    await onCreated(result.data.user, result.data.temporaryPassword);
  };
  return (
    <form className="admin-form" onSubmit={(event) => void submit(event)} aria-label={fa ? "کارمند جدید" : "New employee"}>
      <h2>{fa ? "کارمند جدید" : "New employee"}</h2>
      <p className="admin-hint">{fa ? "سیستم یک رمز موقت می‌سازد که فقط یک بار نمایش داده می‌شود." : "The system creates a temporary password that is shown once."}</p>
      <label><span>{fa ? "نام کاربری" : "Username"}</span><input dir="ltr" value={login} onChange={(event) => setLogin(event.target.value.toLowerCase())} required pattern="[a-z0-9][a-z0-9._\-]{2,63}" autoComplete="off" />
        <small>{fa ? "حروف کوچک لاتین، عدد، نقطه، خط تیره. مثال: m.karimi" : "Lowercase letters, digits, dot or dash. Example: m.karimi"}</small></label>
      <ProfileFields value={profile} onChange={setProfile} fa={fa} />
      <fieldset className="admin-status-choice"><legend>{fa ? "وضعیت آغازین" : "Initial status"}</legend>
        <label><input type="radio" name="status" checked={status === "ACTIVE"} onChange={() => setStatus("ACTIVE")} />{fa ? "فعال" : "Active"}</label>
        <label><input type="radio" name="status" checked={status === "DISABLED"} onChange={() => setStatus("DISABLED")} />{fa ? "معلق" : "Suspended"}</label>
      </fieldset>
      <h3>{fa ? "نقش‌ها" : "Roles"}</h3>
      <RolePicker roles={roles} chosen={chosen} fa={fa} onToggle={(id) => setChosen((current) => toggle(current, id))} />
      <button type="submit" className="treasury-button gold" disabled={busy}>{busy ? (fa ? "در حال ایجاد…" : "Creating…") : (fa ? "ایجاد حساب" : "Create account")}</button>
    </form>
  );
}

function UserPanel({ user, roles, fa, locale, t, onProfile, onStatus, onRoles, onSessions, onReset }: {
  readonly user: UserDetail; readonly roles: readonly RoleSummary[]; readonly fa: boolean; readonly locale: "en" | "fa"; readonly t: (copy: Copy) => string;
  readonly onProfile: (body: ProfileBody) => Promise<void>; readonly onStatus: (status: "ACTIVE" | "DISABLED") => Promise<void>;
  readonly onRoles: (roleIds: string[]) => Promise<void>; readonly onSessions: () => Promise<void>; readonly onReset: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<ProfileBody>({ displayName: user.displayName, jobTitle: user.jobTitle ?? "", contactEmail: user.contactEmail ?? "", contactPhone: user.contactPhone ?? "" });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(user.roles.map((role) => role.id)));
  const [confirming, setConfirming] = useState<"suspend" | "reset" | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } finally { setBusy(false); setConfirming(null); } };
  const rolesChanged = chosen.size !== user.roles.length || user.roles.some((role) => !chosen.has(role.id));

  return (
    <div className="admin-user-panel">
      <header>
        <span className="treasury-avatar" aria-hidden="true">{user.displayName.split(" ").map((part) => part[0]).slice(-2).join("")}</span>
        <div><h2>{user.displayName}</h2><small dir="ltr">{user.loginIdentifier}</small></div>
        <StatusChip user={user} fa={fa} />
      </header>
      {user.isYou ? <p className="admin-hint">{fa ? "این حساب شماست. نقش‌ها و وضعیت خود را نمی‌توانید تغییر دهید؛ مدیر دیگری باید این کار را انجام دهد." : "This is your own account. You cannot change your own roles or status; another administrator must."}</p> : null}

      <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void run(() => onProfile(profile)); }}>
        <h3>{fa ? "مشخصات" : "Details"}</h3>
        <ProfileFields value={profile} onChange={setProfile} fa={fa} />
        <button type="submit" className="treasury-button" disabled={busy}>{fa ? "ذخیره مشخصات" : "Save details"}</button>
      </form>

      <section className="admin-section">
        <h3>{fa ? "نقش‌ها" : "Roles"}</h3>
        <RolePicker roles={roles} chosen={chosen} fa={fa} disabled={user.isYou || busy} onToggle={(id) => setChosen((current) => toggle(current, id))} />
        <button type="button" className="treasury-button" disabled={user.isYou || busy || !rolesChanged} onClick={() => void run(() => onRoles([...chosen]))}>{fa ? "ذخیره نقش‌ها" : "Save roles"}</button>
      </section>

      <section className="admin-section">
        <h3>{fa ? "آنچه این کارمند می‌تواند انجام دهد" : "What this employee can do"}</h3>
        {user.effectivePermissions.length === 0 ? <p className="admin-hint">{fa ? "هیچ دسترسی. این کارمند نمی‌تواند وارد شود." : "No access. This employee cannot sign in."}</p> : (
          <ul className="admin-effective">{user.effectivePermissions.map((item) => (
            <li key={item.code}><strong>{copyText(PERMISSION_COPY[item.code]?.label, item.code, t)}</strong>
              <small>{fa ? "از طریق: " : "Through: "}{item.viaRoles.join(", ") || (fa ? "اعطای مستقیم" : "direct grant")}</small>
              {PERMISSION_COPY[item.code]?.independence ? <em>{copyText(PERMISSION_COPY[item.code]?.independence, "", t)}</em> : null}</li>
          ))}</ul>
        )}
      </section>

      <section className="admin-section admin-actions">
        <h3>{fa ? "حساب و نشست‌ها" : "Account and sessions"}</h3>
        <p className="admin-hint">{fa ? `نشست‌های فعال: ${user.activeSessions}` : `Active sessions: ${user.activeSessions}`}</p>
        <div>
          {user.status === "ACTIVE"
            ? confirming === "suspend"
              ? <><button type="button" className="treasury-button danger" disabled={busy} onClick={() => void run(() => onStatus("DISABLED"))}>{fa ? "بله، معلق کن" : "Yes, suspend"}</button><button type="button" className="treasury-button quiet" onClick={() => setConfirming(null)}>{fa ? "لغو" : "Cancel"}</button></>
              : <button type="button" className="treasury-button danger" disabled={user.isYou || busy} onClick={() => setConfirming("suspend")}>{fa ? "تعلیق حساب" : "Suspend account"}</button>
            : <button type="button" className="treasury-button gold" disabled={user.isYou || busy} onClick={() => void run(() => onStatus("ACTIVE"))}>{fa ? "فعال‌سازی دوباره" : "Reactivate account"}</button>}
          {confirming === "reset"
            ? <><button type="button" className="treasury-button gold" disabled={busy} onClick={() => void run(onReset)}>{fa ? "بله، رمز موقت بساز" : "Yes, issue a temporary password"}</button><button type="button" className="treasury-button quiet" onClick={() => setConfirming(null)}>{fa ? "لغو" : "Cancel"}</button></>
            : <button type="button" className="treasury-button" disabled={user.isYou || busy} onClick={() => setConfirming("reset")}>{fa ? "بازنشانی رمز" : "Reset password"}</button>}
          <button type="button" className="treasury-button quiet" disabled={busy || user.activeSessions === 0} onClick={() => void run(onSessions)}>{fa ? "خروج از همه جا" : "Sign out everywhere"}</button>
        </div>
      </section>

      <section className="admin-section">
        <h3>{fa ? "فعالیت اخیر" : "Recent activity"}</h3>
        <AuditList entries={user.recentActivity} t={t} locale={locale} fa={fa} />
      </section>
    </div>
  );
}

function AuditList({ entries, t, locale, fa }: { readonly entries: readonly AuditEntry[]; readonly t: (copy: Copy) => string; readonly locale: "en" | "fa"; readonly fa: boolean }) {
  if (entries.length === 0) return <p className="admin-hint">{fa ? "هنوز فعالیتی ثبت نشده است." : "No activity recorded yet."}</p>;
  return <ol className="admin-audit">{entries.map((entry) => (
    <li key={entry.id}><time dateTime={entry.occurredAt}>{formatWhen(entry.occurredAt, locale)}</time>
      <strong>{copyText(AUDIT_ACTION_COPY[entry.action], entry.action, t)}</strong>
      <span>{entry.target}</span><small>{fa ? "توسط " : "by "}{entry.actor}</small></li>
  ))}</ol>;
}

function HistoryPanel({ entries, fa, t, locale }: { readonly entries: readonly AuditEntry[]; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly locale: "en" | "fa" }) {
  return (
    <section className="module-content-card admin-history">
      <div className="module-card-heading"><div><p>{fa ? "ثبت تغییرناپذیر" : "APPEND-ONLY RECORD"}</p><h2>{fa ? "تاریخچه دسترسی شرکت" : "Company access history"}</h2></div></div>
      <p className="admin-hint">{fa ? "هر ایجاد، تغییر نقش، تعلیق، بازنشانی رمز و خروج اجباری با نام شخصی که آن را انجام داده ثبت می‌شود و قابل ویرایش نیست." : "Every creation, role change, suspension, password reset and forced sign-out is recorded with the person who did it, and cannot be edited."}</p>
      <AuditList entries={entries} t={t} locale={locale} fa={fa} />
    </section>
  );
}

function copyText(copy: Copy | undefined, fallback: string, t: (copy: Copy) => string): string {
  return copy ? t(copy) : fallback;
}

function toggle(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
