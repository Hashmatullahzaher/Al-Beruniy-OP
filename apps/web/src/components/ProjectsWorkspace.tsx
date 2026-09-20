"use client";

import Image from "next/image";
import { useMemo, useState } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceEmptyState, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const projectFixtures = [
  { id: "MM-001", name: "Mazar Mall", type: "Mixed-use development", location: "Mazar-e-Sharif", status: "active", progress: 68, phases: "Not connected", tone: "gold", imagePosition: "34% center" },
  { id: "ABR-A", name: "Al-Beruniy Residence", type: "Residential · Tower A", location: "Presentation fixture", status: "active", progress: 72, phases: "Not connected", tone: "blue", imagePosition: "12% center" },
  { id: "BAQI-01", name: "BAQI Tower", type: "Residential tower", location: "Presentation fixture", status: "planning", progress: 48, phases: "Not connected", tone: "cyan", imagePosition: "66% center" },
  { id: "LUX-01", name: "Luxe Living", type: "Premium apartments", location: "Presentation fixture", status: "planning", progress: 35, phases: "Not connected", tone: "green", imagePosition: "86% center" }
] as const;

const projectTabs = [
  { id: "all", label: { en: "All projects", fa: "همه پروژه‌ها" }, count: 4 },
  { id: "active", label: { en: "Active", fa: "فعال" }, count: 2 },
  { id: "planning", label: { en: "Planning", fa: "برنامه‌ریزی" }, count: 2 }
] as const;

export function ProjectsWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("MM-001");

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projectFixtures.filter((project) =>
      (activeTab === "all" || project.status === activeTab)
      && (!normalizedQuery || `${project.name} ${project.id} ${project.type}`.toLowerCase().includes(normalizedQuery))
    );
  }, [activeTab, query]);

  const selectedProject = projectFixtures.find((project) => project.id === selectedId) ?? projectFixtures[0];

  return (
    <div className="module-workspace projects-workspace">
      <StageZeroPageHeader
        icon="projects"
        eyebrow={{ en: "Portfolio / Project workspace", fa: "فضای کاری پروژه و مجموعه" }}
        title={{ en: "Projects", fa: "پروژه‌ها" }}
        description={{ en: "Review the authorized project portfolio and maintain a clear project context.", fa: "مجموعه پروژه‌های مجاز را مرور و زمینه پروژه را روشن نگه دارید." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Project creation is not connected in Stage 0"><AppIcon name="projects" size={16} />{localized({ en: "New project unavailable", fa: "پروژه جدید در دسترس نیست" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Project portfolio", fa: "مجموعه پروژه‌ها" }} />

      <section className="module-content-card" aria-labelledby="project-directory-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Authorized portfolio", fa: "مجموعه مجاز" }, locale)}</p><h2 id="project-directory-title">{localized({ en: "Project directory", fa: "فهرست پروژه‌ها" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic presentation fixtures", fa: "نمونه‌های نمایشی ساختگی" }, locale)}</span>
        </div>

        <div className="module-toolbar">
          <WorkspaceTabs label="Project status" tabs={projectTabs} active={activeTab} onChange={setActiveTab} />
          <label className="module-search-field">
            <span className="sr-only">{localized({ en: "Search demo projects", fa: "جستجوی پروژه‌های نمایشی" }, locale)}</span>
            <AppIcon name="search" size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={localized({ en: "Search project or code…", fa: "جستجوی پروژه یا کد…" }, locale)} />
          </label>
        </div>

        <div className="project-directory-layout">
          <div className="project-list" role="list" aria-label={localized({ en: "Demo project directory", fa: "فهرست پروژه‌های نمایشی" }, locale)}>
            {visibleProjects.length ? visibleProjects.map((project) => (
              <div role="listitem" key={project.id}>
                <button className={`project-directory-row ${selectedProject.id === project.id ? "selected" : ""}`} type="button" aria-label={`Select ${project.name} demo project`} onClick={() => setSelectedId(project.id)}>
                  <span className="project-row-image"><Image src="/assets/al-beruniy-background.jpg" alt="" fill sizes="76px" style={{ objectPosition: project.imagePosition }} /></span>
                  <span className="project-row-name"><strong>{project.name}</strong><small>{project.id} · {project.type}</small></span>
                  <span className={`project-status-chip ${project.status}`}>{localized(project.status === "active" ? { en: "Active demo", fa: "نمونه فعال" } : { en: "Planning demo", fa: "نمونه برنامه‌ریزی" }, locale)}</span>
                  <span className="project-row-progress"><b>{project.progress}%</b><i><em style={{ width: `${project.progress}%` }} /></i><small>{localized({ en: "Illustrative progress", fa: "پیشرفت نمایشی" }, locale)}</small></span>
                  <AppIcon name="chevron" size={16} />
                </button>
              </div>
            )) : <WorkspaceEmptyState icon="search" title={{ en: "No matching demo projects", fa: "پروژه نمایشی مطابق یافت نشد" }} description={{ en: "Change the search or status filter. No operational project service is connected.", fa: "جستجو یا فیلتر وضعیت را تغییر دهید. سرویس عملیاتی پروژه متصل نیست." }} />}
          </div>

          <aside className="project-detail-panel" aria-live="polite">
            <div className="project-detail-image"><Image src="/assets/al-beruniy-background.jpg" alt="Mazar Mall and Al-Beruniy development rendering" fill sizes="360px" style={{ objectPosition: selectedProject.imagePosition }} /><span>DEMO DATA</span></div>
            <div className="project-detail-copy">
              <p>{selectedProject.id}</p><h2>{selectedProject.name}</h2><span>{selectedProject.type}</span>
              <dl>
                <div><dt>{localized({ en: "Location", fa: "موقعیت" }, locale)}</dt><dd>{selectedProject.location}</dd></div>
                <div><dt>{localized({ en: "Structure", fa: "ساختار" }, locale)}</dt><dd>{selectedProject.phases}</dd></div>
                <div><dt>{localized({ en: "Operational records", fa: "سوابق عملیاتی" }, locale)}</dt><dd>{localized({ en: "Unavailable", fa: "در دسترس نیست" }, locale)}</dd></div>
              </dl>
              <div className="project-boundary-note"><AppIcon name="shield" size={17} /><p><strong>{localized({ en: "Stage 0 boundary", fa: "مرز مرحله صفر" }, locale)}</strong>{localized({ en: "No project master data, budgets, bank references, or permissions are connected.", fa: "هیچ داده اصلی پروژه، بودجه، مرجع بانکی یا مجوزی متصل نیست." }, locale)}</p></div>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
