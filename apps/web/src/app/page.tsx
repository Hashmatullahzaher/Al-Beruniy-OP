"use client";

import Image from "next/image";
import Link from "next/link";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";

const demoKpis: ReadonlyArray<{ icon: AppIconName; label: string; value: string; note: string; trend: string; tone?: string; trendTone?: "up" | "down" }> = [
  { icon: "projects", label: "Total Projects", value: "8", note: "Portfolio fixture", trend: "+1 this year" },
  { icon: "key", label: "Units Sold", value: "1,284", note: "72% of demo total", trend: "+12% MoM", tone: "gold" },
  { icon: "overview", label: "Available Units", value: "496", note: "28% remaining", trend: "−6% MoM", tone: "blue", trendTone: "down" },
  { icon: "coins", label: "Cash Collected", value: "$186.4M", note: "76% of demo target", trend: "+18% YoY", tone: "gold" },
  { icon: "reports-analytics", label: "Construction Progress", value: "68%", note: "Weighted demo average", trend: "+9% vs plan" },
  { icon: "alert", label: "Overdue Installments", value: "$6.8M", note: "3.7% of receivables", trend: "+12% MoM", tone: "danger", trendTone: "down" },
  { icon: "procurement", label: "Procurement Commitments", value: "$54.2M", note: "Demo committed", trend: "−8% vs budget" },
  { icon: "chart", label: "Profit / Loss (YTD)", value: "$28.6M", note: "Demo margin 18.4%", trend: "+22% YoY" }
];

const projectProgress = [
  ["Mazar Mall", "Mixed Use Complex", 85],
  ["Al-Beruniy Residence", "Tower A", 72],
  ["Al-Beruniy Residence", "Tower B", 61],
  ["BAQI Tower", "Residential", 48],
  ["Luxe Living", "Premium Apartments", 35]
] as const;

const aiItems: ReadonlyArray<{ icon: AppIconName; title: string; body: string; tone: string }> = [
  { icon: "chart", title: "Sales Momentum", body: "Demo signal based on presentation fixtures.", tone: "success" },
  { icon: "alert", title: "Payment Risk Alert", body: "Synthetic risk preview — no live receivables.", tone: "danger" },
  { icon: "settings", title: "Cost Optimization", body: "Recommendation shell awaiting governed sources.", tone: "blue" },
  { icon: "key", title: "Market Opportunity", body: "Illustrative insight, not an operational forecast.", tone: "gold" }
];

const departments: ReadonlyArray<{ icon: AppIconName; name: string; line1: string; line2: string; tone: string }> = [
  { icon: "finance", name: "Finance", line1: "Healthy cash flow", line2: "Demo collections", tone: "green" },
  { icon: "sales-crm", name: "Sales & CRM", line1: "1,284 units sold", line2: "72% sell-through", tone: "blue" },
  { icon: "construction", name: "Construction", line1: "68% average progress", line2: "Demo on track", tone: "gold" },
  { icon: "procurement", name: "Procurement", line1: "$54.2M committed", line2: "Demo budget", tone: "cyan" },
  { icon: "human-resources", name: "Human Resources", line1: "246 team members", line2: "Demo retention", tone: "blue" }
];

const alerts = [
  ["Payment overdue — Unit B-1204", "2 hours ago", "danger"],
  ["Construction milestone completed", "5 hours ago", "warning"],
  ["New client registration — demo", "1 day ago", "info"],
  ["Material price increase — fixture", "1 day ago", "warning"]
] as const;

export default function OverviewPage() {
  const { locale } = useLocale();
  const isDari = locale === "fa";

  return (
    <div className="reference-dashboard">
      <h1 className="sr-only">{isDari ? "مرکز فرماندهی سازمانی البرونی" : "Al-Beruniy Enterprise Command Center"}</h1>

      <section className="reference-hero" aria-labelledby="reference-hero-title">
        <Image src="/assets/al-beruniy-background.jpg" alt="Architectural rendering of Mazar Mall and the Al-Beruniy district" fill loading="eager" sizes="(max-width: 760px) 100vw, 90vw" />
        <div className="reference-hero-shade" />
        <div className="reference-hero-copy">
          <div className="hero-label-row"><span>{isDari ? "پروژه شاخص" : "Flagship development"}</span><em>DEMO DATA</em></div>
          <h2 id="reference-hero-title">{isDari ? "مزار مال و ناحیه البرونی" : <>Mazar Mall &amp;<br />Al-Beruniy District</>}</h2>
          <p>{isDari ? "زندگی مدرن، جوامع پویا." : "Modern Living. Thriving Communities."}</p>
          <i aria-hidden="true" />
          <div className="hero-feature-row">
            <span><AppIcon name="pin" size={21} /><b>{isDari ? "موقعیت ممتاز" : "Prime Location"}</b><small>Mazar-e-Sharif</small></span>
            <span><AppIcon name="building" size={21} /><b>{isDari ? "کاربری مختلط" : "Mixed Use"}</b><small>Retail | Residential | Offices</small></span>
            <span><AppIcon name="human-resources" size={21} /><b>{isDari ? "فردای روشن‌تر" : "A Brighter"}</b><small>Tomorrow</small></span>
          </div>
        </div>
        <div className="hero-brand-panel" aria-hidden="true">
          <span>Iconic developments<br />Lasting value</span>
          <svg viewBox="0 0 48 58" fill="none"><path d="M24 3v49M18 11v41M30 11v41M12 23v29M36 23v29M7 52h34M13 39l11-9 11 9M18 25l6-8 6 8"/><path d="M5 55h38"/></svg>
          <strong>ALBERUNIY</strong><small>DEVELOPMENTS</small>
          <em>More than Buildings<br />We Build Possibilities</em>
        </div>
      </section>

      <section className="kpi-strip" aria-label="Synthetic demonstration metrics">
        {demoKpis.map((kpi) => (
          <article className={`reference-kpi ${kpi.tone ?? "cyan"}`} key={kpi.label}>
            <span className="reference-kpi-icon"><AppIcon name={kpi.icon} size={24} /></span>
            <div><small>{kpi.label}</small><strong>{kpi.value}</strong><p>{kpi.note}</p><em className={kpi.trendTone === "down" ? "down" : undefined}>{kpi.trendTone === "down" ? "↓" : "↑"} {kpi.trend}</em></div>
          </article>
        ))}
      </section>

      <div className="analytics-grid">
        <section className="dashboard-panel sales-panel" aria-labelledby="sales-title">
          <header><h2 id="sales-title">Sales Performance <span>DEMO</span></h2><Link href="/sales-crm">View Details →</Link></header>
          <div className="panel-summary"><div><strong>$243.1M</strong><small>Total Sales Value</small><em>↑ +16% YoY</em></div><div className="period-tabs"><span className="active">Monthly</span><span>Quarterly</span><span>Yearly</span></div></div>
          <div className="bar-chart" role="img" aria-label="Synthetic monthly sales performance chart">
            {[16,18,22,28,24,20,26,27,31,34,33,36].map((height, index) => <span key={index} style={{ height: `${height * 2}px` }}><i>{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][index]}</i></span>)}
            <svg viewBox="0 0 360 100" preserveAspectRatio="none" aria-hidden="true"><path d="M4 77 C45 69 73 60 104 55 S170 49 204 42 S270 35 356 18"/><circle cx="102" cy="55" r="3"/></svg>
          </div>
          <div className="chart-legend"><span><i className="blue" />Units Sold Value</span><span><i className="gold" />Target</span></div>
        </section>

        <section className="dashboard-panel progress-panel" aria-labelledby="progress-title">
          <header><h2 id="progress-title">Project Progress <span>DEMO</span></h2><Link href="/projects">View All Projects →</Link></header>
          <div className="project-progress-list">
            {projectProgress.map(([name, type, progress], index) => (
              <div className="project-progress-row" key={`${name}-${type}`}>
                <span className="project-thumb"><Image src="/assets/al-beruniy-background.jpg" alt="" fill sizes="54px" style={{ objectPosition: `${20 + index * 16}% center` }} /></span>
                <div className="project-name"><strong>{name}</strong><small>{type}</small></div>
                <div className="project-meter"><b>{progress}%</b><span><i style={{ width: `${progress}%` }} /></span></div>
                <AppIcon name="chevron" size={14} />
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-panel cash-panel" aria-labelledby="cash-title">
          <header><h2 id="cash-title">Cash Flow Overview <span>DEMO</span></h2><Link href="/finance">View Details →</Link></header>
          <div className="cash-summary"><span><strong>$186.4M</strong><small>Collected</small><em>↑ +18%</em></span><span><strong>$60.2M</strong><small>Remaining</small></span><span><strong>76%</strong><small>Collection Rate</small></span></div>
          <div className="line-chart" role="img" aria-label="Synthetic cumulative cash collection chart">
            <svg viewBox="0 0 400 145" preserveAspectRatio="none"><g className="grid"><path d="M0 25h400M0 55h400M0 85h400M0 115h400"/><path d="M35 0v135M85 0v135M135 0v135M185 0v135M235 0v135M285 0v135M335 0v135"/></g><path className="target-line" d="M4 128 396 18"/><path className="cash-area" d="M4 132 C45 118 76 108 112 97 S176 79 214 69 S285 52 330 39 S370 31 396 26 L396 140 L4 140Z"/><path className="cash-line" d="M4 132 C45 118 76 108 112 97 S176 79 214 69 S285 52 330 39 S370 31 396 26"/>{[4,45,82,120,160,200,240,280,320,360,396].map((x, i) => <circle key={x} cx={x} cy={132 - i * 10.5} r="2.5" />)}</svg>
            <div className="month-row">{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((month) => <span key={month}>{month}</span>)}</div>
          </div>
          <div className="chart-legend"><span><i className="gold" />Cumulative Collected</span><span><i className="dash" />Target</span></div>
        </section>

        <section className="dashboard-panel ai-panel" aria-labelledby="ai-title">
          <header><h2 id="ai-title">AI Insights <span>BETA · DEMO</span></h2><Link href="/ai-insights">View All →</Link></header>
          <div className="ai-list">
            {aiItems.map((item) => <article className={item.tone} key={item.title}><span><AppIcon name={item.icon} size={20} /></span><div><strong>{item.title}</strong><p>{item.body}</p></div></article>)}
          </div>
        </section>
      </div>

      <div className="bottom-grid">
        <section className="dashboard-panel department-panel" aria-labelledby="department-title">
          <header><h2 id="department-title">Department Overview <span>DEMO</span></h2></header>
          <div className="department-list">
            {departments.map((department) => <article key={department.name} className={department.tone}><span><AppIcon name={department.icon} size={19} /></span><div><strong>{department.name}</strong><p>{department.line1}<br />{department.line2}</p><em>↗</em></div></article>)}
          </div>
        </section>

        <section className="dashboard-panel alerts-panel" aria-labelledby="alerts-title">
          <header><h2 id="alerts-title">Latest Alerts <span>DEMO</span></h2><Link href="/ai-insights">View All →</Link></header>
          <div>{alerts.map(([title, time, tone]) => <article key={title}><AppIcon name={tone === "info" ? "ai-insights" : "alert"} size={13} /><span>{title}</span><time>{time}</time></article>)}</div>
        </section>

        <aside className="vision-card">
          <Image src="/assets/al-beruniy-background.jpg" alt="Al-Beruniy development skyline" fill sizes="320px" />
          <div><strong>Discipline today.<br />Extraordinary tomorrow.</strong><span /><small>AL-BERUNIY DEVELOPMENTS</small></div>
        </aside>
      </div>
    </div>
  );
}
