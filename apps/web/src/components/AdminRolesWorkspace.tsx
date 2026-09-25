"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api, errorText, type RoleSummary } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { CATEGORY_COPY, PERMISSION_COPY, type Copy } from "@/lib/access-copy";

interface CatalogueEntry {
  readonly code: string; readonly category: string; readonly availability: "ACTIVE" | "UNAVAILABLE_IN_PREVIEW";
  readonly independenceEnforced: boolean; readonly administrative: boolean; readonly catalogueVersion: number;
}

interface Draft { name: string; description: string; status: "ACTIVE" | "INACTIVE"; permissions: ReadonlySet<string> }

export function AdminRolesWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const session = useSession();
  const canEdit = session.can("admin.roles.manage");
  const isSuperAdmin = session.can("admin.roles.manage") && session.can("admin.users.manage");
  const [roles, setRoles] = useState<readonly RoleSummary[] | null>(null);
  const [catalogue, setCatalogue] = useState<readonly CatalogueEntry[]>([]);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const applyRoles = useCallback((result: Awaited<ReturnType<typeof api<readonly RoleSummary[]>>>) => {
    if (result.ok) { setRoles(result.data); setGate(null); return; }
    setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
  }, []);

  useEffect(() => {
    let current = true;
    void api<readonly RoleSummary[]>("/api/v1/admin/roles").then((result) => { if (current) applyRoles(result); });
    void api<readonly CatalogueEntry[]>("/api/v1/admin/catalogue").then((result) => { if (current && result.ok) setCatalogue(result.data); });
    return () => { current = false; };
  }, [applyRoles]);

  const role = useMemo(() => roles?.find((item) => item.id === selected) ?? null, [roles, selected]);
  const locked = !canEdit || (role?.youHoldThis ?? false);

  const choose = (id: string | "new") => {
    setSelected(id); setMessage(null);
    const found = roles?.find((item) => item.id === id);
    setDraft(id === "new" ? { name: "", description: "", status: "ACTIVE", permissions: new Set() }
      : found ? { name: found.name, description: found.description, status: found.status, permissions: new Set(found.permissions) } : null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true); setMessage(null);
    const body = { name: draft.name, description: draft.description, permissions: [...draft.permissions] };
    const result = selected === "new"
      ? await api<RoleSummary>("/api/v1/admin/roles", "POST", body)
      : await api<RoleSummary>(`/api/v1/admin/roles/${selected}`, "PUT", { ...body, status: draft.status, expectedVersion: role?.version ?? -1 });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
    applyRoles(await api<readonly RoleSummary[]>("/api/v1/admin/roles"));
    setSelected(result.data.id);
    setDraft({ name: result.data.name, description: result.data.description, status: result.data.status, permissions: new Set(result.data.permissions) });
    setMessage({ tone: "ok", text: selected === "new"
      ? (fa ? "نقش ایجاد شد." : "Role created.")
      : (fa ? "نقش ذخیره شد. دارندگان این نقش خارج شدند تا دسترسی جدید فوراً اعمال شود." : "Role saved. Everyone holding it was signed out so the new access applies at once.") });
  };

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Roles are managed by people with the “Manage roles and permissions” permission.", fa: "نقش‌ها توسط کسانی مدیریت می‌شوند که صلاحیت «مدیریت نقش‌ها و صلاحیت‌ها» را دارند." }} /></div>;

  const categories = [...new Set(catalogue.map((entry) => entry.category))];

  return (
    <div className="module-workspace admin-workspace">
      <StageZeroPageHeader icon="shield"
        eyebrow={{ en: "Administration · permission catalogue v1", fa: "مدیریت · فهرست صلاحیت‌ها نسخه ۱" }}
        title={{ en: "Roles & permissions", fa: "نقش‌ها و صلاحیت‌ها" }}
        description={{ en: "A role is a named set of permissions from a fixed list. Only permissions the system actually enforces can be chosen.", fa: "نقش مجموعه‌ای نام‌دار از صلاحیت‌های یک فهرست ثابت است. فقط صلاحیت‌هایی قابل انتخاب‌اند که سیستم واقعاً اعمال می‌کند." }}>
        {canEdit ? <button type="button" className="treasury-button gold" onClick={() => choose("new")}><AppIcon name="shield" size={15} />{fa ? "نقش جدید" : "New role"}</button> : null}
      </StageZeroPageHeader>

      <section className="permission-legend" aria-label={fa ? "راهنما" : "Legend"}>
        <span><i className="state allowed" aria-hidden="true" />{fa ? "مجاز" : "Allowed"}</span>
        <span><i className="state denied" aria-hidden="true" />{fa ? "غیرمجاز" : "Not allowed"}</span>
        <span><i className="state independent" aria-hidden="true" />{fa ? "نیازمند استقلال: سیستم اجازه نمی‌دهد همان شخص کار خود را تایید کند" : "Requires independent approval: the system never lets the same person approve their own work"}</span>
        <span><i className="state unavailable" aria-hidden="true" />{fa ? "در این پیش‌نمایش موجود نیست" : "Unavailable in this preview"}</span>
      </section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      <section className="admin-grid">
        <div className="module-content-card admin-list">
          {roles === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : roles.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز نقشی وجود ندارد." : "No roles yet."}</p> : roles.map((item) => (
            <button key={item.id} type="button" className={selected === item.id ? "selected" : ""} onClick={() => choose(item.id)}>
              <span className="treasury-avatar" aria-hidden="true"><AppIcon name="shield" size={16} /></span>
              <span><strong>{item.name}{item.youHoldThis ? <em className="admin-you">{fa ? "نقش شما" : "Your role"}</em> : null}</strong>
                <small>{item.permissions.length} {fa ? "صلاحیت" : item.permissions.length === 1 ? "permission" : "permissions"} · {item.holders.length} {fa ? "دارنده" : item.holders.length === 1 ? "holder" : "holders"}</small></span>
              <em className={`treasury-chip ${item.status === "ACTIVE" ? "ok" : "muted"}`}>{item.status === "ACTIVE" ? (fa ? "فعال" : "Active") : (fa ? "غیرفعال" : "Inactive")}</em>
            </button>
          ))}
        </div>

        <div className="module-content-card admin-detail">
          {draft === null ? <div className="treasury-placeholder"><AppIcon name="shield" size={24} /><p>{fa ? "یک نقش را انتخاب کنید یا نقش جدید بسازید." : "Choose a role, or create a new one."}</p></div> : (
            <form className="admin-form role-editor" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={fa ? "ویرایش نقش" : "Role editor"}>
              <h2>{selected === "new" ? (fa ? "نقش جدید" : "New role") : draft.name || role?.name}</h2>
              {role?.youHoldThis ? <p className="admin-hint">{fa ? "شما این نقش را دارید، پس نمی‌توانید آنچه اجازه می‌دهد را تغییر دهید. مدیر دیگری باید این کار را انجام دهد." : "You hold this role, so you cannot change what it allows. Another administrator must do it."}</p> : null}
              {!canEdit ? <p className="admin-hint">{fa ? "شما فقط می‌توانید نقش‌ها را ببینید." : "You can view roles but not change them."}</p> : null}
              <label><span>{fa ? "نام نقش" : "Role name"}</span><input value={draft.name} disabled={locked} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required minLength={2} maxLength={80} /></label>
              <label><span>{fa ? "توضیح" : "Description"}</span><textarea value={draft.description} disabled={locked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={500} rows={2} /></label>
              {selected !== "new" ? (
                <fieldset className="admin-status-choice" disabled={locked}><legend>{fa ? "وضعیت" : "Status"}</legend>
                  <label><input type="radio" checked={draft.status === "ACTIVE"} onChange={() => setDraft({ ...draft, status: "ACTIVE" })} />{fa ? "فعال" : "Active"}</label>
                  <label><input type="radio" checked={draft.status === "INACTIVE"} onChange={() => setDraft({ ...draft, status: "INACTIVE" })} />{fa ? "غیرفعال (دارندگان دسترسی را از دست می‌دهند)" : "Inactive (holders lose this access)"}</label>
                </fieldset>
              ) : null}

              <h3>{fa ? "صلاحیت‌ها" : "Permissions"}</h3>
              {categories.map((category) => (
                <fieldset key={category} className="permission-group" disabled={locked}>
                  <legend>{t(CATEGORY_COPY[category] ?? { en: category, fa: category })}</legend>
                  {catalogue.filter((entry) => entry.category === category).map((entry) => {
                    const copy = PERMISSION_COPY[entry.code];
                    const unavailable = entry.availability !== "ACTIVE";
                    const superOnly = (entry.administrative || entry.independenceEnforced) && !isSuperAdmin;
                    const allowed = draft.permissions.has(entry.code);
                    return (
                      <label key={entry.code} className={`permission-row ${allowed ? "allowed" : "denied"} ${unavailable ? "unavailable" : ""}`}>
                        <input type="checkbox" checked={allowed} disabled={unavailable || superOnly}
                          onChange={() => setDraft({ ...draft, permissions: toggle(draft.permissions, entry.code) })} />
                        <span className="permission-state" aria-hidden="true">{unavailable ? (fa ? "موجود نیست" : "Unavailable") : allowed ? (fa ? "مجاز" : "Allowed") : (fa ? "غیرمجاز" : "Not allowed")}</span>
                        <span className="permission-text">
                          <strong>{copy ? t(copy.label) : entry.code}</strong>
                          <small>{copy ? t(copy.allows) : ""}</small>
                          {entry.independenceEnforced && copy?.independence ? <em className="permission-independent">{t(copy.independence)}</em> : null}
                          {unavailable ? <em className="permission-unavailable">{fa ? "در این پیش‌نمایش پیاده نشده است؛ قابل انتخاب نیست." : "Not implemented in this preview; cannot be chosen."}</em> : null}
                          {superOnly ? <em className="permission-unavailable">{fa ? "فقط مدیر ارشد می‌تواند این را تعیین کند." : "Only a Super Administrator can set this."}</em> : null}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              ))}

              {role ? (
                <section className="admin-section">
                  <h3>{fa ? "دارندگان این نقش" : "People holding this role"}</h3>
                  {role.holders.length === 0 ? <p className="admin-hint">{fa ? "هیچ‌کس." : "Nobody yet."}</p> : <ul className="role-holders">{role.holders.map((holder) => <li key={holder.id}>{holder.displayName}{holder.status !== "ACTIVE" ? ` · ${fa ? "معلق" : "suspended"}` : ""}</li>)}</ul>}
                </section>
              ) : null}

              {canEdit && !role?.youHoldThis ? <button type="submit" className="treasury-button gold" disabled={busy}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : selected === "new" ? (fa ? "ایجاد نقش" : "Create role") : (fa ? "ذخیره نقش" : "Save role")}</button> : null}
            </form>
          )}
        </div>
      </section>
    </div>
  );
}

function toggle(current: ReadonlySet<string>, code: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(code)) next.delete(code); else next.add(code);
  return next;
}
