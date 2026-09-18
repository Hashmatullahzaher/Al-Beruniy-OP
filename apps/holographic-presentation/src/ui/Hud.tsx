import type { WorldState } from '../world/WorldScene';
import type { GestureState } from '../services/gestureEngine';
import { EDGE_KIND_META, type EdgeKind } from '../data/graph/types';
import { JOURNEYS } from '../data/graph/journeys';
import { NODE_BY_ID, TOP_NODES } from '../data/graph/nodes';

export interface HudProps {
  state: WorldState;
  gesture: GestureState | null;
  gesturesOn: boolean; gestureError: string | null;
  help: boolean; presenter: boolean;
  tourIndex: number; tourCaption: string | null;
  onFilter: (k: EdgeKind, on: boolean) => void;
  onSolo: (k: EdgeKind | null) => void;
  onJourney: (id: string | null) => void;
  onSelect: (id: string) => void;
  onReset: () => void;
  onToggleGestures: () => void;
  onToggleSafe: () => void;
  onToggleLabels: () => void;
  onTogglePresenter: () => void;
  onToggleHelp: () => void;
  onTour: (dir: 1 | -1 | 0) => void;
}

const KINDS = Object.keys(EDGE_KIND_META) as EdgeKind[];

export function Hud(p: HudProps) {
  const s = p.state; const sel = s.selected ? NODE_BY_ID[s.selected] : null;
  const crumbs = s.stack.map(id => NODE_BY_ID[id]?.short ?? NODE_BY_ID[id]?.label ?? id);
  return (
    <>
      {/* brand — tiny */}
      <div className="hud tl">
        <div className="brand">AL-BERUNIY <span>OPERATING SYSTEM</span></div>
        <div className="mode">{s.trace ? `TRACE ${s.trace.code} · ${s.trace.title}` : sel ? `FOCUS · ${sel.label}` : 'ENTERPRISE VIEW'} <em>· {s.nodeCount} nodes · {s.edgeCount} relationships{s.safe ? ' · SAFE MODE' : ''}</em></div>
      </div>

      {/* legend — tiny, clickable filters */}
      <div className="hud tr legend">
        {KINDS.map(k => (
          <button key={k} className={s.filters.includes(k) ? 'on' : 'off'} title={`${EDGE_KIND_META[k].label} — ${EDGE_KIND_META[k].style} (click: toggle · double-click: solo)`}
            onClick={() => p.onFilter(k, !s.filters.includes(k))} onDoubleClick={() => p.onSolo(k)}>
            <i style={{ background: EDGE_KIND_META[k].color }} />{EDGE_KIND_META[k].label}
          </button>
        ))}
        <button className="ghost" onClick={() => p.onSolo(null)}>all</button>
      </div>

      {/* selection / trace breadcrumb */}
      <div className="hud bl">
        {s.trace ? (
          <div className="trace">
            <div className="t">{s.trace.code} · {s.trace.title} <small>{s.trace.ref}</small></div>
            <div className="steps">{s.trace.steps.map((id, i) => <span key={id} className={i === s.traceStep ? 'cur' : ''}>{i + 1}. {NODE_BY_ID[id]?.label ?? id}</span>)}</div>
            <div className="hint">N / B step · Esc exit · 0 clear</div>
          </div>
        ) : sel ? (
          <div className="sel">
            <div className="t">{sel.label} {sel.code && <small>{sel.code}{sel.bp ? ` · BP-${sel.bp}` : ''}</small>}</div>
            {sel.purpose && <div className="p">{sel.purpose}</div>}
            {crumbs.length > 1 && <div className="crumbs">{crumbs.join('  ›  ')}</div>}
            <div className="hint">Esc / fist: back · R / both palms: enterprise view</div>
          </div>
        ) : (
          <div className="sel dim"><div className="t">Explore the operating system</div><div className="p">Drag to orbit · wheel to zoom · click a domain to expand it in place · 1–6 trace journeys · H help</div></div>
        )}
        {p.tourCaption && <div className="tour"><b>TOUR {p.tourIndex + 1}</b> {p.tourCaption} <small>Space next · Shift+Space back</small></div>}
      </div>

      {/* gesture status + reticle */}
      <div className="hud br">
        <div className={`gst ${p.gesturesOn ? (p.gesture?.isTracking ? 'live' : 'idle') : 'off'}`}>
          <i />{p.gesturesOn ? (p.gestureError ? `Gestures unavailable · ${p.gestureError}` : p.gesture?.statusMessage ?? 'Starting camera…') : 'Gestures off · press G'}
        </div>
      </div>
      {p.gesturesOn && p.gesture?.isTracking && (
        <div className={`reticle ${p.gesture.isPinching ? 'pinch' : ''} ${p.gesture.activeGesture}`} style={{ left: `${p.gesture.cursor.x * 100}%`, top: `${p.gesture.cursor.y * 100}%` }} />
      )}

      {/* presenter panel — hidden by default */}
      {p.presenter && (
        <div className="panel">
          <div className="ph">PRESENTER <button onClick={p.onTogglePresenter}>✕</button></div>
          <div className="sec">Journeys</div>
          <div className="row">{JOURNEYS.map(j => <button key={j.id} className={s.trace?.id === j.id ? 'on' : ''} onClick={() => p.onJourney(j.id)}>{j.code}</button>)}<button onClick={() => p.onJourney(null)}>clear</button></div>
          <div className="sec">Focus</div>
          <div className="row wrap">{TOP_NODES.map(n => <button key={n.id} className={s.selected === n.id ? 'on' : ''} onClick={() => p.onSelect(n.id)}>{n.short ?? n.label}</button>)}</div>
          <div className="sec">Guided tour (same world · camera only)</div>
          <div className="row"><button onClick={() => p.onTour(-1)}>◀</button><button onClick={() => p.onTour(1)}>Next ▶</button><button onClick={() => p.onTour(0)}>stop</button></div>
          <div className="sec">System</div>
          <div className="row"><button onClick={p.onToggleGestures}>{p.gesturesOn ? 'Gestures ON' : 'Gestures OFF'}</button><button onClick={p.onToggleSafe}>{s.safe ? 'Safe mode ON' : 'Safe mode OFF'}</button><button onClick={p.onToggleLabels}>{s.labels ? 'Labels ON' : 'Labels OFF'}</button><button onClick={p.onReset}>Reset view</button></div>
        </div>
      )}

      {/* help — hidden by default */}
      {p.help && (
        <div className="help" onClick={p.onToggleHelp}>
          <div className="hb" onClick={e => e.stopPropagation()}>
            <div className="ph">CONTROLS <button onClick={p.onToggleHelp}>✕</button></div>
            <div className="cols">
              <div><b>Mouse</b><ul><li>Drag · orbit</li><li>Right / Shift-drag · pan</li><li>Wheel · zoom</li><li>Hover · inspect</li><li>Click · select & expand in place</li><li>Double-click empty · reset</li></ul></div>
              <div><b>Keyboard</b><ul><li>← → ↑ ↓ / WASD · orbit · Q E pan</li><li>+ / − · zoom</li><li>Esc · back / collapse</li><li>R · enterprise view · F · fullscreen</li><li>1–6 · trace J1–J6 · 0 clear · N / B step</li><li>7 AI Core · 8 Finance · 9 Telegram</li><li>Space · tour next · L labels · X safe mode</li><li>P presenter · G gestures · H help</li></ul></div>
              <div><b>Hand gestures</b><ul><li>Open palm · activate control</li><li>Index point · 3D reticle / hover (dwell to select)</li><li>Pinch · select</li><li>Pinch + move · orbit</li><li>Two-hand spread / close · zoom</li><li>Fist · back / collapse</li><li>Both palms · enterprise view</li></ul></div>
            </div>
            <div className="fine">All three inputs drive the same 3D world and camera. Figures shown in the world are synthetic DEMO values; policies are configurable, not asserted.</div>
          </div>
        </div>
      )}
      <button className="corner" title="Presenter (P)" onClick={p.onTogglePresenter}>⋯</button>
    </>
  );
}
