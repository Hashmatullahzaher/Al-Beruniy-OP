import { useEffect, useRef, useState, useCallback } from 'react';
import { WorldScene, type WorldState } from './world/WorldScene';
import { InputController } from './input/InputController';
import { GestureEngine, type GestureState } from './services/gestureEngine';
import { Hud } from './ui/Hud';
import type { EdgeKind } from './data/graph/types';

/** Guided tour — an optional camera / filter / expansion sequence through the SAME world. */
const TOUR: { caption: string; run: (w: WorldScene) => void }[] = [
  { caption: 'One living 3D enterprise network — every domain, every approved relationship, AI Core at the centre.', run: w => { w.reset(); w.soloFilter(null); } },
  { caption: 'Financial postings: every operational domain converges on the authoritative Finance engine.', run: w => { w.reset(); w.soloFilter('financial'); w.rig.flyTo({ target: w.rig.home.target.clone(), radius: 30, theta: 0.35, phi: 1.05 }, 1.6); } },
  { caption: 'AI knowledge flows INTO the Core; typed tool invocations flow OUT to domain services — never SQL, never posting.', run: w => { w.soloFilter(null); w.setFilter('process', false); w.setFilter('event', false); w.setFilter('document', false); w.setFilter('master_data', false); w.setFilter('audit', false); w.setFilter('notification', false); w.setFilter('integration', false); w.setFilter('security', false); w.setFilter('approval', false); w.rig.flyTo({ target: w.rig.home.target.clone(), radius: 26, theta: -0.4, phi: 1.2 }, 1.6); } },
  { caption: 'AI Core expanded: Model Gateway · Orchestrator · Knowledge Plane · Typed Tools · Memory · Guardrails · Audit · Document Intelligence · Prediction.', run: w => { w.soloFilter(null); w.reset(); w.select('ai_core'); } },
  { caption: 'Finance expanded: GL, AR, AP, Cash & Bank, Journal, Budget, Project Accounting, Cost Centers, Fixed Assets — incoming postings illuminated.', run: w => { w.reset(); w.select('finance'); } },
  { caption: 'J1 · Sale to Cash — Lead → Customer → Unit → Reservation → Contract → Installment → Receipt → AR → Bank → Journal → GL → Dashboard.', run: w => { w.reset(); w.traceJourney('j1'); } },
  { caption: 'J2 · Procure to Pay — site request → PR → RFQ → supplier → PO → GRN → stock → issue → project cost → invoice → AP → payment → GL.', run: w => { w.reset(); w.traceJourney('j2'); } },
  { caption: 'Telegram expanded: Bot API → Gateway → Identity Binding → Permission Context → AI Core → step-up / deep link → notifications.', run: w => { w.reset(); w.select('telegram'); } },
  { caption: 'J6 · Telegram → AI Core — bound user → permission → guardrails → orchestrator → knowledge / typed tool → domain → workflow → audit → response.', run: w => { w.reset(); w.traceJourney('j6'); } },
  { caption: 'Back to the whole company. All parts, one intelligent whole.', run: w => { w.reset(); w.soloFilter(null); } },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const worldRef = useRef<WorldScene | null>(null);
  const inputRef = useRef<InputController | null>(null);
  const gestureRef = useRef<GestureEngine | null>(null);
  const [state, setState] = useState<WorldState | null>(null);
  const [gesture, setGesture] = useState<GestureState | null>(null);
  const [gesturesOn, setGesturesOn] = useState(false);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [presenter, setPresenter] = useState(false);
  const [safe, setSafe] = useState(() => new URLSearchParams(location.search).has('safe'));
  const [tourIndex, setTourIndex] = useState(-1);
  const hooksRef = useRef({ help: false });

  // build / rebuild world (safe mode toggles rebuild the renderer)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const world = new WorldScene(canvas, safe);
    world.onChange = s => setState(s);
    worldRef.current = world; world.sync();
    (window as unknown as { __world?: WorldScene }).__world = world; // test / presenter console hook
    const input = new InputController(canvas, world, {
      onToggleHelp: () => setHelp(h => !h),
      onToggleGestures: () => setGesturesOn(g => !g),
      onToggleSafe: () => setSafe(s => !s),
      onTogglePresenter: () => setPresenter(p => !p),
      onTourNext: () => tour(1), onTourPrev: () => tour(-1),
    });
    inputRef.current = input; (window as unknown as { __input?: InputController }).__input = input;
    let raf = 0; const loop = () => { world.frame(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
    const onResize = () => world.resize(); window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); input.dispose(); world.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe]);

  // gestures
  useEffect(() => {
    if (!gesturesOn) { gestureRef.current?.destroy(); gestureRef.current = null; setGesture(null); return; }
    const eng = new GestureEngine(); gestureRef.current = eng; setGestureError(null);
    eng.initialize(videoRef.current!, s => { setGesture(s); inputRef.current?.applyGesture(s); })
      .then(r => { if (!r.success) setGestureError(r.error ?? 'unavailable'); });
    return () => { eng.destroy(); };
  }, [gesturesOn]);

  const tour = useCallback((dir: 1 | -1 | 0) => {
    const w = worldRef.current; if (!w) return;
    if (dir === 0) { setTourIndex(-1); w.reset(); return; }
    setTourIndex(i => { const n = Math.max(0, Math.min(TOUR.length - 1, (i < 0 ? (dir > 0 ? 0 : TOUR.length - 1) : i + dir))); TOUR[n].run(w); return n; });
  }, []);
  hooksRef.current.help = help;

  const w = worldRef.current;
  return (
    <div className={`app ${presenter || help ? '' : 'presentation'}`}>
      <canvas ref={canvasRef} className="world" />
      <video ref={videoRef} className="cam" playsInline muted />
      {state && (
        <Hud state={state} gesture={gesture} gesturesOn={gesturesOn} gestureError={gestureError} help={help} presenter={presenter}
          tourIndex={tourIndex} tourCaption={tourIndex >= 0 ? TOUR[tourIndex].caption : null}
          onFilter={(k: EdgeKind, on) => w?.setFilter(k, on)} onSolo={k => w?.soloFilter(k)} onJourney={id => w?.traceJourney(id)}
          onSelect={id => w?.select(id)} onReset={() => w?.reset()}
          onToggleGestures={() => setGesturesOn(g => !g)} onToggleSafe={() => setSafe(s => !s)} onToggleLabels={() => w?.toggleLabels()}
          onTogglePresenter={() => setPresenter(p => !p)} onToggleHelp={() => setHelp(h => !h)} onTour={tour} />
      )}
    </div>
  );
}
