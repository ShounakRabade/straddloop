'use client';
/**
 * The Lab workspace: a configuration rail (sections A–F, a sticky Run action) beside a full-width results area.
 * Dates come only from the engine's DateRange (lib/dateRange.ts); figures come only from the run result.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Logo } from '@/components/ui';
import { SYNTHETIC_KEYS, describeParams, fieldChanged, type Field } from '@/lib/strategies';
import { CORE_BUILDER, GROUPS, REGISTRY, inGroup, labStrategy, slugOfResult } from '@/lib/strategyRegistry';
import { useLab, type DayRef } from '@/lib/useLab';
import { useSession } from '@/lib/useSession';
import { cloudEnabled } from '@/lib/supabase';
import { saveRun } from '@/lib/store';
import { availability, download, readLocal, statuses, type Availability, type ExpiryFlag } from '@/lib/marketData';
import { boundsOf, buildDateRange, presetRange, rollingWindows, type InventoryDay, type StatusRow } from '@/lib/dateRange';
import { ENGINE_ONLY_KEYS, PARAM_SPACE, choiceLabel } from '@/lib/researchSpace';
import { SECTIONS, SUBGROUP, sectionOf, type SectionId } from '@/lib/labSections';
import { ROLE_LABEL, sequenceProblems, timeProblem, toMin, type TimeRole } from '@/lib/sessionTime';
import { labCaps } from '@/lib/legs/caps';
import type { Gate, TemplateId } from '@/lib/legs/types';
import Legs from '@/public/engine/legs.js';
import { GLOSSARY } from '@/lib/glossary';
import { inr, shortDate } from '@/lib/format';
import type { LabSlug, Params } from '@/lib/types';
import { Icon, ParamField, Section, Tip, fmtVal } from '@/components/lab/kit';
import { RoleMark, SessionLine, useTimeInterval } from '@/components/lab/TimeField';
import { LegTable } from '@/components/lab/LegTable';
import { DataStatus } from '@/components/lab/DataStatus';
import { RangeBar } from '@/components/lab/RangeBar';
import { RollingView, type RollingState } from '@/components/lab/RollingView';
import { Calendar } from '@/components/lab/Calendar';
import { ResearchPanel } from '@/components/research/ResearchPanel';
import { Exec, ResultTabs, headline, type Baseline, type TabId } from '@/components/lab/Results';

const OPEN_KEY = 'straddloop.open';
const SOURCE_KEY = 'straddloop.source';
const RAIL_KEY = 'straddloop.rail';
const AUTO_KEY = 'straddloop.autorun';
const ROLL_KEY = 'straddloop.rolling';
const TAB_IDS: TabId[] = ['overview', 'capital', 'charts', 'trades', 'sessions', 'rolling', 'replay', 'research', 'diagnostics', 'ledger'];
const NO_STATUS: StatusRow[] = [];
const ROLE_ORDER: TimeRole[] = ['entry', 'last_entry', 'exit'];
type Source = 'synthetic' | 'real';
type LocalDay = { path: string; date: string; buf?: ArrayBuffer };
type Meta = { key: string; dataKey: string; isDefault: boolean };

const GUIDE: { sec: SectionId | null; title: string; body: string }[] = [
  { sec: 'strategy', title: 'Choose a strategy and its legs', body: 'A published rule set, or a structure from the strategy builder. Builder legs can be edited one by one: side, type, strike, size, stop and target.' },
  { sec: 'timing', title: 'Set entry and exit', body: 'Entry, the last minute a new position may open, and the square-off, on one line from 09:15 to 15:30. Type a time or pick one; the order is checked as you go.' },
  { sec: 'risk', title: 'Set stops and targets', body: 'Per leg and for the whole position, in %, premium points or rupees. Type the value or use the slider; the unit is always shown.' },
  { sec: 'data', title: 'Choose the data and the period', body: 'The synthetic model shows how a rule reacts to a setting. Real NIFTY candles show what it would have done; pick the dates on the calendar.' },
  { sec: 'capital', title: 'Check capital, costs and fills', body: 'Starting capital, what happens when margin is short, slippage and brokerage. Margin is an estimate, never your broker’s figure.' },
  { sec: 'advanced', title: 'Advanced rules (optional)', body: 'The published rules’ finer points: entry-candle strictness, breakout definitions. The defaults are the published rules.' },
  { sec: null, title: 'Run and read the result', body: 'Run the backtest, then start with Overview: what happened, what worked, what hurt, and how far to trust it.' },
];

/** A field's value in a section summary: '09:50', '36%', '₹1,000/lot', '2 from ATM' reads '2 ATM'. */
const short = (f: Field, v: unknown, p: Params) => fmtVal(f, v, p).replace(' from ATM', ' ATM');

export function LabClient() {
  const [slug, setSlug] = useState<LabSlug>('straddle');
  const [params, setParams] = useState<Params>(REGISTRY[0].defaults);
  const [booted, setBooted] = useState(false);
  const [source, setSource] = useState<Source>('synthetic');
  const lastBuilder = useRef<LabSlug>('iron_condor');  // the structure the builder option opens on
  const [flag, setFlag] = useState<ExpiryFlag>('WEEK');
  const [avail, setAvail] = useState<Availability | null>(null);
  const [dayStatus, setDayStatus] = useState<StatusRow[]>(NO_STATUS);
  const [local, setLocal] = useState<LocalDay[] | null>(null);
  const [request, setRequest] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<SectionId>>(() => new Set<SectionId>(['strategy', 'data']));
  const [rail, setRail] = useState<'open' | 'collapsed'>('open');
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [autoPref, setAutoPref] = useState({ synthetic: true, real: false });
  const [guide, setGuide] = useState<number | null>(null);
  const [tab, setTabState] = useState<TabId>('overview');
  const [tried, setTried] = useState<string | null>(null);  // config key of the last run asked for
  const [meta, setMeta] = useState<Meta | null>(null);      // config of the result on screen
  const [baseline, setBaseline] = useState<(Baseline & { key: string }) | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<{ state: 'idle' | 'saving' | 'done' | 'error'; msg?: string }>({ state: 'idle' });
  const [beforeLoad, setBeforeLoad] = useState<Params | null>(null);  // the person's settings before they loaded a study's selection
  const lab = useLab();
  const [timeStep, setTimeStep] = useTimeInterval();
  const { session, ready: sessionReady } = useSession();
  const strategy = labStrategy(slug) ?? REGISTRY[0];
  const isFourleg = strategy.engine === 'fourleg';
  const realOk = strategy.realOk;
  const real = source === 'real' && realOk;
  const sent = useRef(new Set<string>());
  const pending = useRef<Meta | null>(null);
  const toggleBtn = useRef<HTMLButtonElement>(null);
  const railHead = useRef<HTMLButtonElement>(null);
  const runBtn = useRef<HTMLButtonElement>(null);

  // Start from a notebook run, a ?s= link, or the default. Restore rail, auto-run and tab preferences.
  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_KEY) === 'collapsed') setRail('collapsed');
      const a = JSON.parse(localStorage.getItem(AUTO_KEY) ?? 'null');
      if (a && typeof a.synthetic === 'boolean' && typeof a.real === 'boolean') setAutoPref(a);
    } catch { /* storage blocked */ }
    const h = window.location.hash.slice(1) as TabId;
    if (TAB_IDS.includes(h)) setTabState(h);
    try {
      const raw = sessionStorage.getItem(OPEN_KEY);
      if (raw) {
        sessionStorage.removeItem(OPEN_KEY);
        const p = JSON.parse(raw) as Params, s = labStrategy(String(p.strategy));
        if (s) {
          setSlug(s.slug); setParams({ ...s.defaults, ...p, strategy: s.slug }); if (!s.syntheticOk) setSource('real');
          if (s.family === 'builder') lastBuilder.current = s.slug;
          if (p.data_from) { setSource('real'); setRequest({ from: String(p.data_from), to: String(p.data_to ?? '') }); if (p.data_flag === 'MONTH') setFlag('MONTH'); }
          setBooted(true); return;
        }
      }
    } catch { /* fall through to the default */ }
    const q = new URLSearchParams(window.location.search);
    const s = labStrategy(q.get('s') ?? '');
    if (s) { setSlug(s.slug); setParams(s.defaults); if (!s.syntheticOk) setSource('real'); if (s.family === 'builder') lastBuilder.current = s.slug; }
    try { if (q.get('data') === 'real' || localStorage.getItem(SOURCE_KEY) === 'real' || (s && !s.syntheticOk)) setSource('real'); } catch { /* storage blocked */ }
    setBooted(true);
  }, []);

  // What real data exists for the chosen series, and its ingestion statuses.
  useEffect(() => {
    if (!real || local) return;
    let live = true;
    setAvail(null); setDataErr(null); setDayStatus(NO_STATUS);
    Promise.all([availability('NIFTY', flag), statuses('NIFTY', flag).catch(() => NO_STATUS)])
      .then(([a, st]) => { if (live) { setDayStatus(st.length ? st : NO_STATUS); setAvail(a); } })
      .catch((e) => live && setAvail({ state: 'off', why: `Supabase: ${(e as Error).message}` }));
    return () => { live = false; };
  }, [real, flag, local]);

  const inventory: InventoryDay[] = useMemo(
    () => (local ? local.map((d) => ({ trade_date: d.date, path: d.path, quality: 'local' })) : avail?.state === 'ready' ? avail.days : []),
    [local, avail]);
  const statusRows = local ? NO_STATUS : dayStatus;

  // An empty request starts at the last 30 stored sessions. A request the user made is never changed.
  useEffect(() => {
    if (!real || !inventory.length || (request.from && request.to)) return;
    const p = presetRange('last_30', inventory, statusRows);
    if (p) setRequest(p);
  }, [real, inventory, statusRows, request.from, request.to]);

  const range = useMemo(
    () => (real && inventory.length ? buildDateRange(request, inventory, statusRows, { source: local ? 'local' : 'dhan', series: flag }) : null),
    [real, inventory, statusRows, request, local, flag]);

  // Builder legs edited by hand no longer use the structure's strike offset and width, so those two are hidden.
  const legsEdited = strategy.family === 'builder' && typeof params.legs === 'string' && !!params.legs;
  const fields = useMemo(() => strategy.fields.filter((f) => !(real && SYNTHETIC_KEYS.includes(f.key)) && !(legsEdited && (f.key === 'offset' || f.key === 'width'))), [real, strategy, legsEdited]);
  const changed = useMemo(() => describeParams({ ...strategy, fields }, params), [strategy, fields, params]);
  const lotSet = Number(params.lot_size) > 0;
  // Engine settings that have no field in the rail (set only by loading an optimisation study). Always listed, never silent.
  // (a key this strategy has a field for is not engine-only: Strategy 01 and 03 have an exit-time field, so a default
  // run there would otherwise count as "1 changed" and never become the default-rules baseline)
  const engineSet = ENGINE_ONLY_KEYS.filter((k) => params[k] !== undefined && !strategy.fields.some((f) => f.key === k));
  const spaceLabel = (k: string) => [...PARAM_SPACE.straddle, ...PARAM_SPACE.orb].find((x) => x.key === k)?.label ?? k;
  const nChanged = changed.length + (lotSet ? 1 : 0) + engineSet.length;
  const realReady = !!range && range.runnable.length > 0;

  // What the run request carries: builder structures add their StrategySpec, built from these parameters.
  const runParams = useMemo((): Params => {
    const base = strategy.toRunParams(params, { series: real ? flag : 'WEEK' });
    if (!real || !range || !range.runnable.length) return base;
    return { ...base, data_from: range.runnable[0], data_to: range.runnable[range.runnable.length - 1], data_flag: flag, range_key: range.key };
  }, [strategy, real, range, params, flag]);
  const configKey = useMemo(() => JSON.stringify([slug, real ? 'real' : 'syn', runParams]), [slug, real, runParams]);

  // Times: each inside its own bounds and grain, and in order (entry before square-off, last new entry not after it).
  const timeFields = fields.filter((f): f is Extract<Field, { kind: 'time' }> => f.kind === 'time');
  const timeOwn = useMemo(() => timeFields.flatMap((f) => {
    const t = timeProblem(toMin(params[f.key]), { min: toMin(f.min)!, max: toMin(f.max)!, grain: f.grain });
    return t ? [{ key: f.key, level: 'error' as const, text: `${f.label}: ${t}` }] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [fields, params]);
  const timeSeq = useMemo(() => sequenceProblems(timeFields.map((f) => ({ key: f.key, role: f.role, value: toMin(params[f.key]) })), params.hold !== 'expiry'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, params]);
  const timeChecks = [...timeOwn, ...timeSeq];
  // Builder strategies: the engine's own checks on the spec this run would send, against what the data source holds.
  const legGates = useMemo((): { errors: Gate[]; warnings: Gate[] } => {
    if (strategy.family !== 'builder' || typeof runParams.spec !== 'string') return { errors: [], warnings: [] };
    const v = Legs.validate(JSON.parse(runParams.spec), labCaps(real, flag));
    return { errors: v.errors, warnings: v.warnings.filter((g) => g.code !== 'NO_BID_ASK' && g.code !== 'EXPIRY_ASSUMED') };
  }, [strategy.family, runParams.spec, real, flag]);
  const blockers = timeChecks.filter((c) => c.level === 'error').length + legGates.errors.length;
  const canRun = booted && !strategy.blocked && !blockers && (real ? realReady : true);
  const dataKey = real ? `real:${flag}:${range?.key ?? ''}` : isFourleg ? `syn:${params.months}` : `syn:${params.days}:${params.seed}:${params.iv}`;
  const isDefault = useMemo(
    () => strategy.fields.filter((f) => !SYNTHETIC_KEYS.includes(f.key) && f.key !== 'months').every((f) => !fieldChanged(f, params, strategy.defaults)) && !lotSet && !engineSet.length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strategy, params, lotSet, engineSet.length]);

  const runNow = useCallback(async () => {
    if (!canRun || loading) return;
    setTried(configKey);
    setSaved({ state: 'idle' });
    const m: Meta = { key: configKey, dataKey, isDefault };
    if (!real) { pending.current = m; lab.run(runParams); return; }
    const r = range!;
    setDataErr(null);
    const missing = r.files.filter((f) => !sent.current.has(f.path));
    let fresh: { path: string; buf: ArrayBuffer }[] = [];
    try {
      if (local) fresh = missing.map((f) => ({ path: f.path, buf: (local.find((x) => x.path === f.path)!.buf as ArrayBuffer).slice(0) }));
      else if (missing.length) {
        setLoading({ done: 0, total: missing.length });
        fresh = await download(missing.map((f) => f.path), (done) => setLoading({ done, total: missing.length }));
      }
    } catch (e) {
      setLoading(null);
      setDataErr(`Could not download the day files: ${(e as Error).message}. Nothing ran; press Run to try again.`);
      return;
    }
    setLoading(null);
    fresh.forEach((f) => sent.current.add(f.path));
    const bufs = new Map(fresh.map((f) => [f.path, f.buf]));
    const days: DayRef[] = r.files.map((f) => ({ path: f.path, buf: bufs.get(f.path) }));
    pending.current = m;
    lab.run(runParams, days);
  }, [canRun, loading, configKey, dataKey, isDefault, real, lab, range, local, runParams]);
  const runRef = useRef(runNow);
  runRef.current = runNow;

  // A finished run: remember which settings produced it, and keep the default rules as the baseline.
  useEffect(() => {
    if (lab.status !== 'done' || !lab.result || !pending.current) return;
    const m = pending.current;
    setMeta(m);
    // baselines are per Lab strategy (two builder structures both run on the leg engine, so the engine is not enough)
    const who = slugOfResult(lab.result);
    if (m.isDefault) setBaseline((b) => (b && b.strategy === who && b.dataKey === m.dataKey && b.label !== 'Default rules' ? b
      : { label: 'Default rules', dataKey: m.dataKey, strategy: who, m: headline(lab.result!), key: m.key }));
  }, [lab.status, lab.result]);

  const autoOn = real ? autoPref.real : autoPref.synthetic;
  useEffect(() => {
    if (!booted || !autoOn || !canRun || configKey === tried) return;
    const t = setTimeout(() => runRef.current(), real ? 450 : 220);
    return () => clearTimeout(t);
  }, [booted, autoOn, canRun, configKey, tried, real]);

  // Ctrl/Cmd + Enter runs from anywhere; Escape closes the drawer.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runRef.current(); }
      else if (e.key === 'Escape' && drawer && !document.querySelector('.tip-pop')) { setDrawer(false); toggleBtn.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [drawer]);
  useEffect(() => { if (drawer) railHead.current?.focus(); }, [drawer]);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const on = () => { setNarrow(mq.matches); if (!mq.matches) setDrawer(false); };
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const r0 = lab.result && slugOfResult(lab.result) === slug ? lab.result : null;
  const r = r0 && (real ? !!r0.data : !r0.data) ? r0 : null;
  const stale = !!r && meta?.key !== configKey;
  const busy = lab.status === 'running' || !!loading;
  const cmp = r && baseline && meta && baseline.strategy === slug && baseline.dataKey === meta.dataKey && baseline.key !== meta.key ? baseline : null;
  const outcomes = useMemo(() => (r && !stale && r.days ? new Map(r.days.map((d) => [d.date, d])) : undefined), [r, stale]);

  // ---------- rolling windows: the same rules over successive windows of the selected period (real data)
  const [roll, setRollState] = useState({ on: false, w: 120, s: 30 });
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(ROLL_KEY) ?? 'null'); if (v && typeof v.on === 'boolean') setRollState({ on: v.on, w: Number(v.w) || 120, s: Number(v.s) || 30 }); } catch { /* storage blocked */ } }, []);
  const setRoll = (patch: Partial<typeof roll>) => setRollState((x) => { const n = { ...x, ...patch }; try { localStorage.setItem(ROLL_KEY, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const plan = useMemo(() => (real && range?.effective && roll.w >= 5 && roll.s >= 1 ? rollingWindows(range.effective, roll.w, roll.s) : null), [real, range, roll.w, roll.s]);
  const rollKey = JSON.stringify([configKey, roll.w, roll.s]);
  const [rollRun, setRollRun] = useState<{ key: string; state: RollingState } | null>(null);
  const rollCancel = useRef<(() => void) | null>(null);
  // start once the whole-period run on screen is current; each set of settings runs once (a result is kept per key)
  useEffect(() => {
    if (!roll.on || !real || !r || stale || lab.status !== 'done' || !plan?.windows.length || !range || rollRun?.key === rollKey) return;
    const key = rollKey, total = plan.windows.length, w = roll.w, st = roll.s;
    const job = lab.rolling({ params: runParams, days: range.files.map((f) => ({ path: f.path })), windows: plan.windows },
      (p) => setRollRun((x) => (x && x.key === key ? { key, state: { status: 'running', done: p.done, total: p.total, label: p.label } } : x)));
    rollCancel.current = job.cancel;
    setRollRun({ key, state: { status: 'running', done: 0, total } });
    job.done.then((res) => setRollRun((x) => (x && x.key === key
      ? { key, state: res.ok ? { status: 'done', result: res.rolling, stale: false, w, s: st } : { status: 'error', error: res.error === 'cancelled' ? 'cancelled before the last window' : res.error } } : x)));
  }, [roll.on, roll.w, roll.s, real, r, stale, lab, plan, range, rollRun?.key, rollKey, runParams]);
  // settings changed while windows were running: stop them (their answer would be for the old settings)
  useEffect(() => {
    if (rollRun && rollRun.key !== rollKey && rollRun.state.status === 'running') { rollCancel.current?.(); setRollRun(null); }
  }, [rollKey, rollRun]);
  const rollingState: RollingState = !roll.on || !real ? { status: 'off' }
    : !plan || !plan.windows.length ? { status: 'empty', why: roll.w >= 5 && roll.s >= 1 ? `The selected period is shorter than one ${roll.w}-day window. Pick a longer period or a shorter window.` : 'Set a window of at least 5 days and a step of at least 1 day.' }
      : rollRun?.key === rollKey ? rollRun.state
        : rollRun && rollRun.state.status === 'done' ? { ...rollRun.state, stale: true } : { status: 'waiting' };

  const setTab = useCallback((t: TabId) => { setTabState(t); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } }, []);
  const toggleSec = (id: SectionId) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const showSec = useCallback((id: SectionId) => {
    setOpen((s) => new Set(s).add(id));
    if (window.matchMedia('(max-width: 1023px)').matches) setDrawer(true);
    else setRail('open');
    requestAnimationFrame(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }, []);
  const goGuide = (i: number | null) => {
    setGuide(i);
    if (i == null) return;
    const s = GUIDE[i].sec;
    if (s) showSec(s); else requestAnimationFrame(() => runBtn.current?.focus());
  };
  const toggleRail = () => {
    if (window.matchMedia('(max-width: 1023px)').matches) { setDrawer((d) => !d); return; }
    setRail((x) => { const n = x === 'open' ? 'collapsed' : 'open'; try { localStorage.setItem(RAIL_KEY, n); } catch { /* ignore */ } return n; });
  };
  const setAuto = (v: boolean) => setAutoPref((p) => { const n = { ...p, [real ? 'real' : 'synthetic']: v }; try { localStorage.setItem(AUTO_KEY, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const pick = (next: LabSlug) => {
    const s = labStrategy(next);
    if (!s) return;
    setSlug(s.slug); setParams(s.defaults); if (!s.syntheticOk) pickSource('real');
    if (s.family === 'builder') lastBuilder.current = s.slug;
    setNote(''); setSaveOpen(false); setBeforeLoad(null);
  };
  const resetAll = () => { setParams(strategy.defaults); setBeforeLoad(null); };
  /** Only ever called by the person pressing "Load" in the optimisation lab. */
  const loadFromStudy = (changes: Record<string, unknown>) => { setBeforeLoad(params); setParams((p) => ({ ...p, ...(changes as Params) })); };
  const pickSource = (s: Source) => { setSource(s); try { localStorage.setItem(SOURCE_KEY, s); } catch { /* ignore */ } };
  const set = (k: string, v: string | number | boolean) => setParams((p) => ({ ...p, [k]: v }));

  async function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    const got = await readLocal(files);
    if (!got.length) { setDataErr('None of those files look like day files (for example NIFTY/WEEK/2025-10-06.json.gz). Make them with: straddloop export-days'); return; }
    sent.current.clear();
    setLocal(got);
    setRequest({ from: got[0].date, to: got[got.length - 1].date });
  }

  async function keep() {
    if (!r) return;
    setSaved({ state: 'saving' });
    try {
      const p = real ? { ...params, data_from: r.data!.from, data_to: r.data!.to, data_flag: flag } : params;
      const { where } = await saveRun(slug, p, r, note.trim());
      setSaved({ state: 'done', msg: where === 'cloud' ? 'Saved to your account.' : 'Saved in this browser.' });
    } catch (e) {
      setSaved({ state: 'error', msg: `Could not save: ${(e as Error).message}. Your settings are still here, so you can try again.` });
    }
  }

  const offMessage = (why: string) => {
    if (why === 'cloud') return <>Supabase is not set up on this site, so real data cannot be fetched.</>;
    if (why === 'signin') return <><Link className="qlink" href="/login">Sign in</Link> to use the real data. It is private to your account.</>;
    if (why === 'reader') return <>This account is not on the data readers list. Add it in Supabase (table <code>data_readers</code>).</>;
    return <>{why}</>;
  };

  // ---------- per-section content, counts and summaries ----------
  const inSec = (id: SectionId) => fields.filter((f) => sectionOf(f.key) === id && f.kind !== 'legs');
  const changedIn = (id: SectionId) => inSec(id).filter((f) => fieldChanged(f, params, strategy.defaults)).length + (id === 'capital' && lotSet ? 1 : 0)
    + (id === 'strategy' && legsEdited ? 1 : 0);
  const problemOf = (key: string) => timeSeq.find((c) => c.key === key) ?? null;
  const field = (f: Field, warn?: string | null) => (
    <ParamField key={f.key} f={f} p={params} d={strategy.defaults} set={set} idPrefix={slug} tip={GLOSSARY[f.key] ?? f.help} warn={warn}
      time={f.kind === 'time' ? { interval: timeStep, onInterval: setTimeStep, problem: problemOf(f.key) } : undefined} />
  );
  /** A section's fields under their sub-headings, in the order the headings first appear. */
  const grouped = (id: SectionId, skip: (f: Field) => boolean = () => false) => {
    const fs = inSec(id).filter((f) => !skip(f));
    const order: string[] = [];
    for (const f of fs) { const g = SUBGROUP[f.key] ?? ''; if (!order.includes(g)) order.push(g); }
    return order.flatMap((g) => [g ? <div className="sub-h" key={`h-${g}`}>{g}</div> : null, ...fs.filter((f) => (SUBGROUP[f.key] ?? '') === g).map((f) => field(f, f.key === 'slip_pct' && real && slip === 0 ? 'Zero slippage on real candles overstates results.' : null))]);
  };
  const slip = Number(params.slip_pct ?? 0);
  const fileLot = range?.days.find((d) => d.file?.lot_size)?.file?.lot_size ?? null;
  const seriesName = flag === 'WEEK' ? 'weekly' : 'monthly';
  const periodText = real
    ? (range?.effective && range.runnable.length ? `${shortDate(range.runnable[0])} – ${shortDate(range.runnable[range.runnable.length - 1])} · ${range.runnable.length} sessions` : 'choose dates')
    : isFourleg ? `${params.months} months` : `${params.days} sessions`;
  const dataErrors = (real && !local && avail && avail.state !== 'ready' ? 1 : 0) + (real && range && !range.runnable.length ? 1 : 0);
  const periodWarn = !!range && (range.counts.partial > 0 || range.counts.missing > 0 || range.messages.some((m) => m.level === 'note' && /moved/.test(m.text)));
  const sumOf = (id: SectionId, n: number) => inSec(id).slice(0, n).map((f) => short(f, params[f.key], params));
  const sectionSummary: Record<SectionId, string> = {
    strategy: [strategy.short, legsEdited ? 'legs edited' : null, ...sumOf('strategy', 2)].filter(Boolean).join(' · '),
    timing: timeFields.length ? timeFields.map((f) => `${f.role === 'entry' ? 'in' : f.role === 'exit' ? 'out' : 'last'} ${params[f.key]}`).join(' · ') : isFourleg ? 'Monthly: after each expiry' : sumOf('timing', 2).join(' · ') || 'Fixed by the rules',
    risk: isFourleg ? sumOf('risk', 2).join(' · ') : inSec('risk').filter((f) => f.kind === 'level' && Number(params[f.key]) > 0).slice(0, 3).map((f) => short(f, params[f.key], params)).join(' · ') || 'No stops or targets',
    data: real ? `${local ? `${local.length} files` : `NIFTY ${seriesName}`} · ${periodText}` : isFourleg ? `Synthetic · four stocks · ${periodText}` : `Synthetic · ${periodText} · seed ${params.seed}`,
    capital: isFourleg ? 'Fixed in this model' : `${inr(Number(params.capital))} · slip ${slip}% · ₹${params.brokerage_per_order}/order`,
    advanced: inSec('advanced').length ? (changedIn('advanced') ? `${changedIn('advanced')} changed` : 'Published defaults') : 'None for this strategy',
  };

  const researchMeta = useMemo(() => ({ oneLine: strategy.oneLine, changed: [...changed, ...engineSet.map((k) => `${spaceLabel(k)}: ${choiceLabel(params[k])}`)] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strategy, changed, params]);
  const stored = useMemo(() => (real && inventory.length ? boundsOf(inventory, statusRows) : null), [real, inventory, statusRows]);
  const dataNote = real && r?.data && stored?.earliest && stored.latest_any ? `Stored real data runs from ${stored.earliest} to ${stored.latest_any}; this run used ${r.data.days} of those sessions.` : null;

  const checks: { ok: 'true' | 'false' | 'warn'; t: React.ReactNode }[] = [];
  if (!real) checks.push({ ok: 'true', t: isFourleg ? `Synthetic model · ${params.months} months, four stocks` : `Synthetic model · ${params.days} sessions, seed ${params.seed}` });
  else if (!local && !avail) checks.push({ ok: 'warn', t: 'Checking which days are stored…' });
  else if (!local && avail?.state === 'off') checks.push({ ok: 'false', t: offMessage(avail.why) });
  else if (!local && avail?.state === 'empty') checks.push({ ok: 'false', t: `No ${seriesName} days are uploaded yet.` });
  else if (range && !range.runnable.length) checks.push({ ok: 'false', t: range.messages.find((m) => m.level === 'error')?.text ?? 'No stored days in this period.' });
  else if (range) {
    checks.push({ ok: 'true', t: <><b className="num">{range.runnable.length}</b> session{range.runnable.length === 1 ? '' : 's'} will run · {shortDate(range.runnable[0])} – {shortDate(range.runnable[range.runnable.length - 1])}</> });
    if (range.counts.partial) checks.push({ ok: 'warn', t: `${range.counts.partial} partial day${range.counts.partial === 1 ? '' : 's'} included; gaps stay gaps.` });
  }
  if (real && slip === 0) checks.push({ ok: 'warn', t: 'Zero slippage on real candles overstates results.' });
  if (strategy.blocked) checks.push({ ok: 'false', t: strategy.blocked });
  if (dataErr) checks.push({ ok: 'false', t: dataErr });

  const runLabel = loading ? `Downloading ${loading.done}/${loading.total}` : lab.status === 'running' ? 'Running…' : r && !stale ? 'Run again' : 'Run backtest';
  const status = lab.status === 'error' ? { s: 'error', t: 'Stopped' } : busy ? { s: 'running', t: loading ? 'Downloading' : 'Running' }
    : stale ? { s: 'stale', t: 'Settings changed' } : r ? { s: 'done', t: `Done in ${(lab.ms / 1000).toFixed(1)}s` } : { s: 'idle', t: 'Ready' };
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const g = guide != null ? GUIDE[guide] : null;
  const dim = (id: SectionId) => !!g && g.sec !== id;

  const runButton = (cls = '') => (
    <button ref={cls ? undefined : runBtn} type="button" className={`run-btn ${cls}`} disabled={!canRun || busy} onClick={() => { runNow(); setDrawer(false); if (guide === GUIDE.length - 1) setGuide(null); }}
      aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}>
      <Icon.play /><span>{runLabel}</span>{!cls && <kbd>{mac ? '⌘' : 'Ctrl'} ↵</kbd>}
    </button>
  );

  return (
    <div className="ws" data-rail={rail} data-drawer={drawer ? 'open' : 'closed'}>
      <a href="#lab-main" className="skip">Skip to results</a>
      <header className="ws-bar">
        <button ref={toggleBtn} type="button" className="ib" onClick={toggleRail} aria-controls="lab-rail"
          aria-expanded={narrow ? drawer : rail === 'open'} aria-label={narrow ? (drawer ? 'Close settings' : 'Open settings') : rail === 'open' ? 'Hide settings panel' : 'Show settings panel'}>
          <Icon.panel />
        </button>
        <Logo />
        <div className="ws-crumb"><b>Lab</b><span>{strategy.short} · {real ? `real NIFTY ${seriesName}` : 'synthetic model'}</span></div>
        <nav className="ws-nav" aria-label="Main">
          <Link href="/#strategies">Strategies</Link>
          <Link href="/lab" aria-current="page">Lab</Link>
          <Link href="/notebook" className="keep">Notebook</Link>
          {cloudEnabled && sessionReady && <Link href="/login">{session ? 'Account' : 'Sign in'}</Link>}
        </nav>
        <span className="ws-status" data-state={status.s} role="status"><i /><span>{status.t}</span></span>
      </header>

      <aside className="ws-rail" id="lab-rail" aria-label="Backtest settings">
        <div className="rail-head">
          <span className="lbl">Configuration</span>
          {guide == null && <button type="button" className="qbtn" onClick={() => goGuide(0)}>Guide me</button>}
          <button type="button" className="qbtn" onClick={resetAll} disabled={!nChanged}>Reset</button>
          <button ref={railHead} type="button" className="ib" onClick={() => { if (drawer) { setDrawer(false); toggleBtn.current?.focus(); } else toggleRail(); }}
            aria-label={drawer ? 'Close settings' : rail === 'open' ? 'Collapse settings' : 'Expand settings'}>
            {drawer ? <Icon.close /> : rail === 'open' ? <Icon.left /> : <Icon.right />}
          </button>
        </div>
        <button type="button" className="rail-spine" onClick={toggleRail}>Settings{nChanged ? ` · ${nChanged} changed` : ''}</button>

        <div className="rail-body">
          {g && (
            <div className="guide" role="region" aria-label="Guided setup">
              <div className="guide-top"><span className="lbl">Step {guide! + 1} of {GUIDE.length}</span><button type="button" className="qlink" onClick={() => setGuide(null)}>Exit guide</button></div>
              <ol className="guide-steps" aria-hidden="true">{GUIDE.map((_, i) => <li key={i} data-s={i < guide! ? 'done' : i === guide ? 'now' : undefined} />)}</ol>
              <p><b>{g.title}.</b> {g.body}</p>
              <div className="guide-nav">
                <button type="button" className="qbtn" disabled={guide === 0} onClick={() => goGuide(guide! - 1)}>Back</button>
                {guide! < GUIDE.length - 1 ? <button type="button" className="qbtn" onClick={() => goGuide(guide! + 1)}>Next</button>
                  : <button type="button" className="qbtn" aria-pressed="true" disabled={!canRun || busy} onClick={() => { runNow(); setGuide(null); setDrawer(false); }}>Run now</button>}
              </div>
            </div>
          )}

          <Section id="strategy" letter="A" title={SECTIONS[0].title} summary={sectionSummary.strategy} open={open.has('strategy')} onToggle={() => toggleSec('strategy')} changed={changedIn('strategy')} errors={legGates.errors.length} dim={dim('strategy')}>
            <div className="strat-list" role="radiogroup" aria-label="Strategy">
              {inGroup('published').map((s) => (
                <label key={s.slug} className="strat-opt">
                  <input type="radio" name="strategy" checked={s.slug === slug} onChange={() => pick(s.slug)} />
                  <span className="n">{s.number}</span><b>{s.short}</b><small>{s.engine === 'fourleg' ? 'stocks · synthetic' : s.stance}</small>
                </label>
              ))}
              <label className="strat-opt">
                <input type="radio" name="strategy" checked={strategy.family === 'builder'} onChange={() => pick(lastBuilder.current)} />
                <span className="n">B</span><b>Strategy builder</b><small>{CORE_BUILDER.length} structures</small>
              </label>
            </div>
            {strategy.family === 'builder' && (
              <div className="f">
                <div className="f-top">
                  <label className="f-label" htmlFor="lab-structure">Structure</label>
                  <Tip label="Structure" text="Every structure runs on the same leg engine: all legs fill at the same bar or none, charges follow the dated tables, and each position is reconciled against the ledger." />
                </div>
                <select id="lab-structure" className="in" value={slug} onChange={(e) => pick(e.target.value as LabSlug)}>
                  {GROUPS.filter((g) => g.id !== 'published').map((g) => (
                    <optgroup key={g.id} label={g.title}>
                      {inGroup(g.id).map((s) => <option key={s.slug} value={s.slug} disabled={!!s.blocked}>{s.name}{s.blocked ? ' (needs the next expiry)' : ''}</option>)}
                    </optgroup>
                  ))}
                </select>
                <div className="f-meta"><span>{strategy.oneLine} {strategy.stance[0].toUpperCase() + strategy.stance.slice(1)}.</span></div>
              </div>
            )}
            {strategy.family !== 'builder' && <p className="sec-note">{strategy.oneLine}</p>}
            {strategy.family === 'builder'
              ? <LegTable slug={slug as TemplateId} p={params} set={set} real={real} seriesName={seriesName} gates={[...legGates.errors, ...legGates.warnings]} />
              : (
                <>
                  <div className="sub-h">Legs (fixed for this strategy)</div>
                  <table className="legs">
                    <thead><tr><th>Action</th><th>Type</th><th>Strike</th><th>Qty</th><th>Expiry</th></tr></thead>
                    <tbody>{strategy.legs(params).map((l, i) => <tr key={i}><td>{l.action}</td><td>{l.right}</td><td>{l.strike}</td><td>{l.qty}</td><td>{l.expiry}</td></tr>)}</tbody>
                  </table>
                </>
              )}
            {grouped('strategy')}
            {strategy.rulesHref && <p className="sec-note">Full rule text: <Link className="qlink" href={strategy.rulesHref}>{strategy.short} rules</Link>.</p>}
          </Section>

          <Section id="timing" letter="B" title={SECTIONS[1].title} summary={sectionSummary.timing} open={open.has('timing')} onToggle={() => toggleSec('timing')} changed={changedIn('timing')}
            errors={timeChecks.filter((c) => c.level === 'error').length} warns={timeSeq.filter((c) => c.level === 'note').length} dim={dim('timing')}>
            {timeFields.length > 0 && <SessionLine marks={[...timeFields.map((f) => ({ role: f.role, at: toMin(params[f.key]) })), ...strategy.fixedTimes.map((t) => ({ role: t.role, at: toMin(t.at), fixed: t.at }))]} />}
            {[...timeFields].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)).map((f) => field(f))}
            {strategy.fixedTimes.map((t) => (
              <div className="tf-fixed" key={t.role}><RoleMark role={t.role} /><span><b>{ROLE_LABEL[t.role]} {t.at}</b>, fixed: {t.why}</span></div>
            ))}
            <dl className="ro"><dt>Entry</dt><dd>{strategy.entryText(params)}</dd><dt>Exit</dt><dd>{strategy.exitText(params)}</dd></dl>
            {grouped('timing', (f) => f.kind === 'time')}
          </Section>

          <Section id="risk" letter="C" title={SECTIONS[2].title} summary={sectionSummary.risk} open={open.has('risk')} onToggle={() => toggleSec('risk')} changed={changedIn('risk')} dim={dim('risk')}>
            {inSec('risk').length ? grouped('risk') : <p className="sec-note">This strategy has no stop or target settings.</p>}
            {strategy.family === 'builder' && <p className="sec-note">A single leg can have its own stop or target, or none: edit it in the legs table under A.</p>}
          </Section>

          <Section id="data" letter="D" title={SECTIONS[3].title} summary={sectionSummary.data} open={open.has('data')} onToggle={() => toggleSec('data')} errors={dataErrors} warns={periodWarn ? 1 : 0} dim={dim('data')}>
            <fieldset className="f" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="f-top"><legend className="f-label" style={{ padding: 0, float: 'left' }}>Source</legend><Tip label="Source" text="The synthetic model is a labelled imaginary market with dates in 2099. Real data is stored Dhan 1-minute NIFTY option and index candles." /></div>
              <div className="seg2">
                <label><input type="radio" name="source" checked={!real} disabled={!strategy.syntheticOk} onChange={() => pickSource('synthetic')} /><span>Synthetic model</span></label>
                <label><input type="radio" name="source" checked={real} disabled={!realOk} onChange={() => pickSource('real')} /><span>Real NIFTY (Dhan)</span></label>
              </div>
              {!realOk && <div className="f-meta">Real data covers NIFTY index options only, so the four-leg stock strategy stays synthetic.</div>}
              {!strategy.syntheticOk && <div className="f-meta">This strategy needs real NIFTY index and option history.</div>}
            </fieldset>
            {real ? (
              <>
                {!local && (
                  <div className="f">
                    <div className="f-top"><span className="f-label">Expiry series</span><Tip label="Expiry series" text="Which option contracts the day files hold: the nearest weekly expiry, or the monthly one. Expiry dates are assumed from the weekday rule until checked against NSE." /></div>
                    <div className="seg2" role="radiogroup" aria-label="Expiry series">
                      <label><input type="radio" name="flag" checked={flag === 'WEEK'} onChange={() => setFlag('WEEK')} /><span>Weekly</span></label>
                      <label><input type="radio" name="flag" checked={flag === 'MONTH'} onChange={() => setFlag('MONTH')} /><span>Monthly</span></label>
                    </div>
                  </div>
                )}
                {!local && avail?.state === 'off' && <p className="sec-err">{offMessage(avail.why)}</p>}
                {!local && avail?.state === 'empty' && <p className="sec-err">No {seriesName} days are uploaded yet. Run <code>straddloop supabase-upload</code> on your computer.</p>}
                {inventory.length
                  ? <Calendar inventory={inventory} statuses={statusRows} source={local ? 'local' : 'dhan'} series={flag} request={request} onChange={setRequest} range={range} outcomes={outcomes} />
                  : <p className="sec-note">{!local && !avail ? 'Checking which days are stored…' : 'The calendar opens once stored days are available.'}</p>}
                <p className="sec-note">
                  {local ? `${local.length} day files from this computer. ` : avail?.state === 'ready' ? `${avail.days.length} ${seriesName} days stored, ${shortDate(avail.days[0].trade_date)} to ${shortDate(avail.days[avail.days.length - 1].trade_date)}. ` : ''}
                  {local
                    ? <button type="button" className="qlink" onClick={() => { setLocal(null); sent.current.clear(); setRequest({ from: '', to: '' }); }}>Use the stored data instead</button>
                    : <label className="qlink" style={{ cursor: 'pointer' }}>Load day files from this computer<input type="file" accept=".gz" multiple className="sr" onChange={(e) => pickFiles(e.target.files)} /></label>}
                </p>
              </>
            ) : (
              <>
                {grouped('data')}
                <p className="sec-note">Synthetic sessions are generated from the seed, dated in 2099. Pick Real NIFTY to choose calendar dates.</p>
              </>
            )}
          </Section>

          <Section id="capital" letter="E" title={SECTIONS[4].title} summary={sectionSummary.capital} open={open.has('capital')} onToggle={() => toggleSec('capital')} changed={changedIn('capital')} warns={real && slip === 0 ? 1 : 0} dim={dim('capital')}>
            {isFourleg ? <p className="sec-note">The four-leg model uses its own synthetic margin and charges (₹20 an order plus statutory charges inside the model). It has no account settings.</p> : (
              <>
                {inSec('capital').filter((f) => f.key === 'capital').map((f) => field(f))}
                <div className="f" data-changed={lotSet}>
                  <div className="f-top">
                    <label className="f-label" htmlFor="lab-lot">Lot size</label><span className="tag-opt">optional</span>
                    <Tip label="Lot size" text={GLOSSARY.lot_size ?? 'Contracts per lot.'} />
                  </div>
                  {real ? (
                    <>
                      <input id="lab-lot" className="in" type="number" min={0} step={1} inputMode="numeric" placeholder={fileLot ? `From the day files (${fileLot})` : 'From the day files'}
                        value={lotSet ? Number(params.lot_size) : ''} onChange={(e) => set('lot_size', Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                      <div className="f-meta">{lotSet ? <span>Set by you · <button type="button" className="qlink" onClick={() => set('lot_size', 0)}>use the day files’ size</button></span> : <span>Empty uses each day file’s lot size{fileLot ? ` (${fileLot} on the first day)` : ''}, which is assumed until checked against NSE.</span>}</div>
                    </>
                  ) : <div className="f-meta">75, fixed in the synthetic model.</div>}
                </div>
                {grouped('capital', (f) => f.key === 'capital')}
                <p className="sec-note">How fills, charges and margin are modelled: Assumptions, above the results.</p>
              </>
            )}
          </Section>

          <Section id="advanced" letter="F" title={SECTIONS[5].title} summary={sectionSummary.advanced} open={open.has('advanced')} onToggle={() => toggleSec('advanced')} changed={changedIn('advanced')} dim={dim('advanced')}>
            {inSec('advanced').length ? grouped('advanced') : <p className="sec-note">This strategy has no advanced settings.</p>}
          </Section>

          {(engineSet.length > 0 || beforeLoad) && (
            <div className="rail-note" role="status">
              {engineSet.length > 0 && <p><b>Also set, with no field above:</b> {engineSet.map((k) => `${spaceLabel(k)} ${choiceLabel(params[k])}`).join(' · ')}.{' '}
                <button type="button" className="qlink" onClick={() => setParams((p) => { const q = { ...p }; engineSet.forEach((k) => delete q[k]); return q; })}>Clear these</button></p>}
              {beforeLoad && <p>Loaded from the optimisation lab.{' '}<button type="button" className="qlink" onClick={() => { setParams(beforeLoad); setBeforeLoad(null); }}>Put my settings back</button></p>}
            </div>
          )}
        </div>

        <div className="rail-foot">
          <div className="rail-checks" aria-live="polite">
            {checks.map((c, i) => <div key={i} className="rail-check" data-ok={c.ok}><i aria-hidden="true" /><span>{c.t}</span></div>)}
          </div>
          {runButton()}
          <div className="rail-auto">
            <label><input type="checkbox" checked={autoOn} onChange={(e) => setAuto(e.target.checked)} />Re-run on every change</label>
            <span>{nChanged ? `${nChanged} changed` : 'defaults'}</span>
          </div>
        </div>
      </aside>
      <button type="button" className="ws-scrim" aria-label="Close settings" tabIndex={-1} onClick={() => setDrawer(false)} />

      <main id="lab-main" className="ws-main" aria-busy={busy}>
        <div className="ws-inner">
          <DataStatus real={real} local={local ? local.length : null} r={r} slip={slip} brokerage={Number(params.brokerage_per_order ?? 20)} seriesName={seriesName} family={strategy.family}
            syn={{ days: Number(params.days), seed: Number(params.seed), iv: Number(params.iv), months: Number(params.months), fourleg: isFourleg }}
            onSwitch={real ? (strategy.syntheticOk ? { label: 'Use synthetic', go: () => pickSource('synthetic') } : null) : realOk ? { label: 'Use real NIFTY data', go: () => { pickSource('real'); showSec('data'); } } : null} />
          {real && inventory.length > 0 && (
            <RangeBar request={request} setRequest={setRequest} range={range} inventory={inventory} statuses={statusRows}
              rolling={{ on: roll.on, setOn: (v) => setRoll({ on: v }), w: roll.w, setW: (n) => setRoll({ w: n }), s: roll.s, setS: (n) => setRoll({ s: n }), plan }} />
          )}

          {lab.status === 'error' ? (
            <div className="ws-empty" role="alert">
              <span className="lbl">Run stopped</span>
              <h2>The simulation stopped</h2>
              <p className="sec-err">{lab.error}</p>
              <p>{/cost schedule/i.test(lab.error ?? '') ? 'Costs are charged at the rates in force on each trade date, and the table starts on 1 Jul 2020. Choose a later start date.' : 'Nothing below is from this run. Reset the settings and run again.'}</p>
              <div className="run-actions"><button type="button" className="qbtn" onClick={resetAll}>Reset to defaults</button>{runButton('run-btn--inline')}</div>
            </div>
          ) : real && !realReady && !r ? (
            <div className="ws-empty">
              <span className="lbl">Nothing to run yet</span>
              <h2>{!local && !avail ? 'Checking which days are stored' : 'No real days to run'}</h2>
              <p>{!local && avail?.state === 'off' ? offMessage(avail.why) : !local && avail?.state === 'empty' ? `No ${seriesName} days are uploaded yet.` : range?.messages.find((m) => m.level === 'error')?.text ?? 'Pick a period with stored days, or load day files from this computer.'}</p>
              {(local || avail) && <div className="run-actions">{(local || avail?.state === 'ready') && <button type="button" className="qbtn" onClick={() => showSec('data')}>Open the calendar</button>}{strategy.syntheticOk && <button type="button" className="qbtn" onClick={() => pickSource('synthetic')}>Use the synthetic model</button>}</div>}
            </div>
          ) : !r ? (
            busy || (autoOn && canRun) ? (
              <div className="ws-empty" aria-live="polite">
                <span className="lbl">{loading ? 'Downloading day files' : 'Simulating'}</span>
                <h2>{loading ? `Downloading ${loading.done} of ${loading.total} days` : real ? `Replaying ${range?.runnable.length ?? 0} real sessions` : 'Replaying every fill'}</h2>
                {loading && <div className="progress" style={{ width: 'min(420px, 100%)' }} role="progressbar" aria-valuemin={0} aria-valuemax={loading.total} aria-valuenow={loading.done}><i style={{ width: `${(100 * loading.done) / Math.max(1, loading.total)}%` }} /></div>}
                <div className="skel" style={{ width: 'min(640px, 100%)' }} aria-hidden="true"><i /><i style={{ width: '80%' }} /><i style={{ width: '60%' }} /></div>
              </div>
            ) : (
              <div className="ws-empty">
                <span className="lbl">Ready</span>
                <h2>{strategy.name}</h2>
                <p>{real && range ? `${range.runnable.length} real sessions, ${shortDate(range.runnable[0])} to ${shortDate(range.runnable[range.runnable.length - 1])}.` : `${periodText} on the synthetic model.`} {changed.length ? `Changed from the defaults: ${changed.join(' · ')}.` : 'Default rules.'}</p>
                <div className="run-actions">{runButton('run-btn--inline')}<button type="button" className="qbtn" onClick={() => goGuide(0)}>Walk me through the settings</button></div>
              </div>
            )
          ) : (
            <>
              <div className="run-head">
                <div style={{ minWidth: 0 }}>
                  <h1>{strategy.name}</h1>
                  <div className="run-ctx">
                    <span>{r.data ? <>Real NIFTY {seriesName} · <b>{shortDate(r.data.from)} – {shortDate(r.data.to)}</b> · {r.data.days} sessions</> : isFourleg ? <>Synthetic · <b>{params.months} months</b></> : <>Synthetic · <b>{r.sessions} sessions</b> · seed {String(params.seed)}</>}</span>
                    <span>{nChanged ? `${nChanged} changed from defaults` : 'Default rules'}</span>
                    {cmp && <span>Compared with <b>{cmp.label}</b> · <button type="button" className="qlink" onClick={() => setBaseline(null)}>clear</button></span>}
                    {r.account?.report.generated.run_hash && <span title="Run fingerprint: the same settings and data give the same hash">Run {r.account.report.generated.run_hash.slice(0, 8)}</span>}
                  </div>
                </div>
                <div className="run-actions">
                  <button type="button" className="qbtn" aria-pressed={!!baseline && baseline.key === meta?.key} onClick={() => meta && setBaseline({ label: 'Pinned run', dataKey: meta.dataKey, strategy: slug, m: headline(r), key: meta.key })}>
                    {baseline && baseline.key === meta?.key ? 'Baseline' : 'Pin as baseline'}
                  </button>
                  {r.account && <button type="button" className="qbtn" onClick={() => setTab('ledger')}>Export CSV</button>}
                  <button type="button" className="qbtn" aria-expanded={saveOpen} onClick={() => setSaveOpen((s) => !s)}>Save to notebook</button>
                </div>
              </div>
              {stale && (
                <div className="stale" role="status">
                  <span>These results are from earlier settings.</span>
                  {busy ? <span>Running the new settings…</span> : canRun ? <button type="button" className="qlink" onClick={() => runNow()}>Run with the new settings</button> : <span>The new settings cannot run yet; see the panel.</span>}
                </div>
              )}
              {saveOpen && (
                <div className="save-row2">
                  <label className="sr" htmlFor="note">Note for this run</label>
                  <input id="note" className="in" maxLength={280} placeholder="Why this run matters, in a line" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button type="button" className="qbtn" aria-pressed="true" onClick={keep} disabled={busy || stale || saved.state === 'saving' || saved.state === 'done'}>{saved.state === 'saving' ? 'Saving' : saved.state === 'done' ? 'Saved' : 'Save'}</button>
                  {stale && <span className="m-s">Run the new settings first, so the note matches the result.</span>}
                  {saved.msg && <span className={saved.state === 'error' ? 'sec-err' : 'm-s'} role="status">{saved.msg} {saved.state === 'done' && <Link className="qlink" href="/notebook">Open the notebook</Link>}</span>}
                </div>
              )}
              <Exec r={r} busy={busy || stale} baseline={cmp} />
              <ResultTabs r={r} lab={lab} range={range} real={real} slip={Number(params.slip_pct ?? NaN)} tab={tab} setTab={setTab}
                research={<ResearchPanel r={r} lab={lab} params={params} msPerRun={Math.max(5, lab.ms)} meta={researchMeta} partial={real && range ? range.counts.partial : 0} dataNote={dataNote} onLoad={loadFromStudy} />}
                rolling={rollingState.status === 'off' ? undefined : <RollingView state={rollingState} onCancel={() => rollCancel.current?.()} onRetry={() => setRollRun(null)} onOpen={(w) => setRequest(w)} stamp={slug} />}
                rollingCount={plan?.windows.length} />
            </>
          )}
          <p className="foot-legal">Straddloop is a research tool. Real-data runs use 1-minute candles without bid/ask, so fills are optimistic. Nothing here is investment advice or a recommendation to trade. Options trading can lose more than the premium involved. Straddloop does not place orders.</p>
        </div>
      </main>

      <div className="ws-mbar">
        <button type="button" className="qbtn" onClick={() => setDrawer(true)} aria-controls="lab-rail" aria-expanded={drawer}><Icon.sliders /> Settings{nChanged ? ` · ${nChanged}` : ''}</button>
        {runButton('run-btn--bar')}
      </div>
    </div>
  );
}
