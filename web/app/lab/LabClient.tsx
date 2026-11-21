'use client';
/**
 * The Lab workspace: a configuration rail (sections A–F, a sticky Run action) beside a full-width results area.
 * Dates come only from the engine's DateRange (lib/dateRange.ts); figures come only from the run result.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Logo } from '@/components/ui';
import { STRATEGIES, SYNTHETIC_KEYS, bySlug, describeParams, type Field } from '@/lib/strategies';
import { useLab, type DayRef } from '@/lib/useLab';
import { useSession } from '@/lib/useSession';
import { cloudEnabled } from '@/lib/supabase';
import { saveRun } from '@/lib/store';
import { availability, download, readLocal, statuses, type Availability, type ExpiryFlag } from '@/lib/marketData';
import { boundsOf, buildDateRange, presetRange, type InventoryDay, type StatusRow } from '@/lib/dateRange';
import { ENGINE_ONLY_KEYS, PARAM_SPACE, choiceLabel } from '@/lib/researchSpace';
import { ENTRY, EXIT_TEXT, LEGS, SECTIONS, STRATEGY_GROUP, sectionOf, type SectionId } from '@/lib/labSections';
import { GLOSSARY } from '@/lib/glossary';
import { inr, shortDate } from '@/lib/format';
import type { Params, StrategySlug } from '@/lib/types';
import { Icon, ParamField, Section, Tip } from '@/components/lab/kit';
import { Calendar } from '@/components/lab/Calendar';
import { ResearchPanel } from '@/components/research/ResearchPanel';
import { Exec, ResultTabs, headline, type Baseline, type TabId } from '@/components/lab/Results';

const OPEN_KEY = 'straddloop.open';
const SOURCE_KEY = 'straddloop.source';
const RAIL_KEY = 'straddloop.rail';
const AUTO_KEY = 'straddloop.autorun';
const TAB_IDS: TabId[] = ['overview', 'capital', 'charts', 'trades', 'sessions', 'replay', 'research', 'diagnostics', 'ledger'];
const NO_STATUS: StatusRow[] = [];
type Source = 'synthetic' | 'real';
type LocalDay = { path: string; date: string; buf?: ArrayBuffer };
type Meta = { key: string; dataKey: string; isDefault: boolean };

const GUIDE: { sec: SectionId | null; title: string; body: string }[] = [
  { sec: 'strategy', title: 'Choose a strategy', body: 'Each strategy is a fixed set of legs with its own entry and exit rules, listed under it.' },
  { sec: 'data', title: 'Choose the market data', body: 'The synthetic model shows how a rule reacts to a setting. Real NIFTY candles show what the rule would have done on stored days.' },
  { sec: 'period', title: 'Pick the period', body: 'On real data, pick dates on the calendar. Each day shows whether it is stored, partial, missing or a holiday, and the count of sessions that will run.' },
  { sec: 'risk', title: 'Set capital and size', body: 'Starting capital, lots per leg, and what happens when margin is short. Margin is an estimate, never your broker’s figure.' },
  { sec: 'strategy', title: 'Set the exit rules', body: 'Stops, targets and re-entry. A changed value shows its default next to it, with a reset.' },
  { sec: 'execution', title: 'Check costs and fills', body: 'Slippage and brokerage are yours to set. Statutory charges follow the rates in force on each trade date.' },
  { sec: 'advanced', title: 'Advanced rules (optional)', body: 'Entry-candle strictness, strike offset and breakout definitions. The defaults are the published rules.' },
  { sec: null, title: 'Run and read the result', body: 'Run the backtest, then start with Overview: what happened, what worked, what hurt, and how far to trust it.' },
];

const short = (f: Field, v: unknown) => {
  if (f.kind === 'choice') return f.options.find((o) => o.value === v)?.label ?? String(v);
  return `${f.prefix ?? ''}${f.prefix ? Number(v).toLocaleString('en-IN') : v}${(f.unit ?? '').trim() === 'from ATM' ? ' ATM' : f.unit ?? ''}`;
};

export function LabClient() {
  const [slug, setSlug] = useState<StrategySlug>('straddle');
  const [params, setParams] = useState<Params>(STRATEGIES[0].defaults);
  const [booted, setBooted] = useState(false);
  const [source, setSource] = useState<Source>(slug === 'ema_pullback' ? 'real' : 'synthetic');
  const [flag, setFlag] = useState<ExpiryFlag>('WEEK');
  const [avail, setAvail] = useState<Availability | null>(null);
  const [dayStatus, setDayStatus] = useState<StatusRow[]>(NO_STATUS);
  const [local, setLocal] = useState<LocalDay[] | null>(null);
  const [request, setRequest] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<SectionId>>(() => new Set<SectionId>(['strategy', 'data', 'period']));
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
  const { session, ready: sessionReady } = useSession();
  const strategy = bySlug(slug)!;
  const realOk = slug !== 'fourleg';
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
        const p = JSON.parse(raw) as Params, s = bySlug(String(p.strategy));
        if (s) {
          setSlug(s.slug); setParams({ ...s.defaults, ...p }); if (s.slug === 'ema_pullback') setSource('real');
          if (p.data_from) { setSource('real'); setRequest({ from: String(p.data_from), to: String(p.data_to ?? '') }); if (p.data_flag === 'MONTH') setFlag('MONTH'); }
          setBooted(true); return;
        }
      }
    } catch { /* fall through to the default */ }
    const q = new URLSearchParams(window.location.search);
    const s = bySlug(q.get('s') ?? '');
    if (s) { setSlug(s.slug); setParams(s.defaults); if (s.slug === 'ema_pullback') setSource('real'); }
    try { if (q.get('data') === 'real' || localStorage.getItem(SOURCE_KEY) === 'real' || s?.slug === 'ema_pullback') setSource('real'); } catch { /* storage blocked */ }
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

  const fields = useMemo(() => (real ? strategy.fields.filter((f) => !SYNTHETIC_KEYS.includes(f.key)) : strategy.fields), [real, strategy]);
  const changed = useMemo(() => describeParams({ ...strategy, fields }, params), [strategy, fields, params]);
  const lotSet = Number(params.lot_size) > 0;
  // Engine settings that have no field in the rail (set only by loading an optimisation study). Always listed, never silent.
  const engineSet = ENGINE_ONLY_KEYS.filter((k) => params[k] !== undefined);
  const spaceLabel = (k: string) => [...PARAM_SPACE.straddle, ...PARAM_SPACE.orb].find((x) => x.key === k)?.label ?? k;
  const nChanged = changed.length + (lotSet ? 1 : 0) + engineSet.length;
  const realReady = !!range && range.runnable.length > 0;
  const canRun = booted && (real ? realReady : true);

  const runParams = useMemo((): Params => {
    if (!real || !range || !range.runnable.length) return params;
    return { ...params, data_from: range.runnable[0], data_to: range.runnable[range.runnable.length - 1], data_flag: flag, range_key: range.key };
  }, [real, range, params, flag]);
  const configKey = useMemo(() => JSON.stringify([slug, real ? 'real' : 'syn', runParams]), [slug, real, runParams]);
  const dataKey = real ? `real:${flag}:${range?.key ?? ''}` : slug === 'fourleg' ? `syn:${params.months}` : `syn:${params.days}:${params.seed}:${params.iv}`;
  const isDefault = useMemo(
    () => strategy.fields.filter((f) => !SYNTHETIC_KEYS.includes(f.key) && f.key !== 'months').every((f) => params[f.key] === strategy.defaults[f.key]) && !lotSet && !engineSet.length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strategy, params, lotSet, engineSet.length]);

  const runNow = useCallback(async () => {
    if (!canRun || loading) return;
    setTried(configKey);
    setSaved({ state: 'idle' });
    const m: Meta = { key: configKey, dataKey, isDefault };
    if (!real) { pending.current = m; lab.run(params); return; }
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
  }, [canRun, loading, configKey, dataKey, isDefault, real, lab, params, range, local, runParams]);
  const runRef = useRef(runNow);
  runRef.current = runNow;

  // A finished run: remember which settings produced it, and keep the default rules as the baseline.
  useEffect(() => {
    if (lab.status !== 'done' || !lab.result || !pending.current) return;
    const m = pending.current;
    setMeta(m);
    if (m.isDefault) setBaseline((b) => (b && b.strategy === lab.result!.strategy && b.dataKey === m.dataKey && b.label !== 'Default rules' ? b
      : { label: 'Default rules', dataKey: m.dataKey, strategy: lab.result!.strategy, m: headline(lab.result!), key: m.key }));
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

  const r0 = lab.result && lab.result.strategy === slug ? lab.result : null;
  const r = r0 && (real ? !!r0.data : !r0.data) ? r0 : null;
  const stale = !!r && meta?.key !== configKey;
  const busy = lab.status === 'running' || !!loading;
  const cmp = r && baseline && meta && baseline.strategy === r.strategy && baseline.dataKey === meta.dataKey && baseline.key !== meta.key ? baseline : null;
  const outcomes = useMemo(() => (r && !stale && r.days ? new Map(r.days.map((d) => [d.date, d])) : undefined), [r, stale]);

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
  const pick = (next: StrategySlug) => { setSlug(next); setParams(bySlug(next)!.defaults); if (next === 'ema_pullback') pickSource('real'); setNote(''); setSaveOpen(false); setBeforeLoad(null); };
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
  const inSec = (id: SectionId) => fields.filter((f) => sectionOf(f.key) === id);
  const changedIn = (id: SectionId) => inSec(id).filter((f) => params[f.key] !== strategy.defaults[f.key]).length + (id === 'risk' && lotSet ? 1 : 0);
  const field = (f: Field, warn?: string | null) => (
    <ParamField key={f.key} f={f} value={params[f.key]} def={strategy.defaults[f.key]} onChange={(v) => set(f.key, v)} idPrefix={slug} tip={GLOSSARY[f.key] ?? f.help} warn={warn} />
  );
  const slip = Number(params.slip_pct ?? 0);
  const fileLot = range?.days.find((d) => d.file?.lot_size)?.file?.lot_size ?? null;
  const seriesName = flag === 'WEEK' ? 'weekly' : 'monthly';
  const periodText = real
    ? (range?.effective && range.runnable.length ? `${shortDate(range.runnable[0])} – ${shortDate(range.runnable[range.runnable.length - 1])} · ${range.runnable.length} sessions` : 'choose dates')
    : slug === 'fourleg' ? `${params.months} months` : `${params.days} sessions`;
  const dataErrors = real && !local && avail && avail.state !== 'ready' ? 1 : 0;
  const periodErrors = real && range && !range.runnable.length ? 1 : 0;
  const periodWarn = !!range && (range.counts.partial > 0 || range.counts.missing > 0 || range.messages.some((m) => m.level === 'note' && /moved/.test(m.text)));
  const sectionSummary: Record<SectionId, string> = {
    strategy: [strategy.short, ...inSec('strategy').slice(0, 2).map((f) => short(f, params[f.key]))].join(' · '),
    data: real ? (local ? `${local.length} files from this computer` : `NSE · NIFTY · ${seriesName} · 1-min`) : slug === 'fourleg' ? 'Synthetic · four stocks' : `Synthetic · seed ${params.seed} · IV ${params.iv}%`,
    period: periodText,
    risk: slug === 'fourleg' ? 'Fixed in this model' : `${inr(Number(params.capital))} · ${params.lots} lot${Number(params.lots) === 1 ? '' : 's'} · ${short(fields.find((f) => f.key === 'margin_policy')!, params.margin_policy)}`,
    execution: slug === 'fourleg' ? 'Fixed in this model' : `slip ${slip}% · ₹${params.brokerage_per_order}/order`,
    advanced: inSec('advanced').length ? (changedIn('advanced') ? `${changedIn('advanced')} changed` : 'Published defaults') : 'None for this strategy',
  };

  const researchMeta = useMemo(() => ({ oneLine: strategy.oneLine, changed: [...changed, ...engineSet.map((k) => `${spaceLabel(k)}: ${choiceLabel(params[k])}`)] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strategy, changed, params]);
  const stored = useMemo(() => (real && inventory.length ? boundsOf(inventory, statusRows) : null), [real, inventory, statusRows]);
  const dataNote = real && r?.data && stored?.earliest && stored.latest_any ? `Stored real data runs from ${stored.earliest} to ${stored.latest_any}; this run used ${r.data.days} of those sessions.` : null;

  const checks: { ok: 'true' | 'false' | 'warn'; t: React.ReactNode }[] = [];
  if (!real) checks.push({ ok: 'true', t: slug === 'fourleg' ? `Synthetic model · ${params.months} months, four stocks` : `Synthetic model · ${params.days} sessions, seed ${params.seed}` });
  else if (!local && !avail) checks.push({ ok: 'warn', t: 'Checking which days are stored…' });
  else if (!local && avail?.state === 'off') checks.push({ ok: 'false', t: offMessage(avail.why) });
  else if (!local && avail?.state === 'empty') checks.push({ ok: 'false', t: `No ${seriesName} days are uploaded yet.` });
  else if (range && !range.runnable.length) checks.push({ ok: 'false', t: range.messages.find((m) => m.level === 'error')?.text ?? 'No stored days in this period.' });
  else if (range) {
    checks.push({ ok: 'true', t: <><b className="num">{range.runnable.length}</b> session{range.runnable.length === 1 ? '' : 's'} will run · {shortDate(range.runnable[0])} – {shortDate(range.runnable[range.runnable.length - 1])}</> });
    if (range.counts.partial) checks.push({ ok: 'warn', t: `${range.counts.partial} partial day${range.counts.partial === 1 ? '' : 's'} included; gaps stay gaps.` });
  }
  if (real && slip === 0) checks.push({ ok: 'warn', t: 'Zero slippage on real candles overstates results.' });
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

          <Section id="strategy" letter="A" title="Strategy" summary={sectionSummary.strategy} open={open.has('strategy')} onToggle={() => toggleSec('strategy')} changed={changedIn('strategy')} dim={dim('strategy')}>
            <div className="strat-list" role="radiogroup" aria-label="Strategy">
              {STRATEGIES.map((s) => (
                <label key={s.slug} className="strat-opt">
                  <input type="radio" name="strategy" checked={s.slug === slug} onChange={() => pick(s.slug)} />
                  <span className="n">{s.number}</span><b>{s.short}</b><small>{s.stance} · {s.slug === 'fourleg' ? 'four stocks, synthetic model only' : 'intraday, NIFTY options in the Lab'}</small>
                </label>
              ))}
            </div>
            <div className="sub-h">Legs (fixed for this strategy)</div>
            <table className="legs">
              <thead><tr><th>Action</th><th>Type</th><th>Strike</th><th>Qty</th><th>Expiry</th></tr></thead>
              <tbody>{LEGS[slug].map((l, i) => <tr key={i}><td>{l.action}</td><td>{l.right}</td><td>{l.strike}</td><td>{l.qty}</td><td>{l.expiry}</td></tr>)}</tbody>
            </table>
            <dl className="ro"><dt>Entry</dt><dd>{ENTRY[slug]}</dd><dt>Exit</dt><dd>{EXIT_TEXT[slug]}</dd></dl>
            {(['Exit', 'Adjustment', 'Structure'] as const).map((grp) => {
              const fs = inSec('strategy').filter((f) => STRATEGY_GROUP[f.key] === grp);
              return fs.length ? [<div className="sub-h" key={`h${grp}`}>{grp === 'Exit' ? 'Exit rules' : grp === 'Adjustment' ? 'Adjustments' : 'Structure'}</div>, ...fs.map((f) => field(f))] : null;
            })}
            <p className="sec-note">Full rule text: <Link className="qlink" href={`/strategies/${slug}`}>{strategy.short} rules</Link>. A custom leg builder is not in the Lab yet.</p>
          </Section>

          <Section id="data" letter="B" title="Market data" summary={sectionSummary.data} open={open.has('data')} onToggle={() => toggleSec('data')} errors={dataErrors} dim={dim('data')}>
            <fieldset className="f" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="f-top"><legend className="f-label" style={{ padding: 0, float: 'left' }}>Source</legend><Tip label="Source" text="The synthetic model is a labelled imaginary market with dates in 2099. Real data is stored Dhan 1-minute NIFTY option and index candles." /></div>
              <div className="seg2">
                <label><input type="radio" name="source" checked={!real} disabled={slug === 'ema_pullback'} onChange={() => pickSource('synthetic')} /><span>Synthetic model</span></label>
                <label><input type="radio" name="source" checked={real} disabled={!realOk} onChange={() => pickSource('real')} /><span>Real NIFTY (Dhan)</span></label>
              </div>
              {!realOk && <div className="f-meta">Real data covers NIFTY index options only, so the four-leg stock strategy stays synthetic.</div>}
            </fieldset>
            {real ? (
              <>
                <dl className="ro">
                  <dt>Exchange</dt><dd>NSE</dd>
                  <dt>Underlying</dt><dd>NIFTY 50 index options</dd>
                  <dt>Candles</dt><dd>1-minute, from Dhan; no bid/ask</dd>
                  <dt>Stored</dt><dd>{local ? `${local.length} files from this computer` : avail?.state === 'ready' ? `${avail.days.length} ${seriesName} days, ${shortDate(avail.days[0].trade_date)} to ${shortDate(avail.days[avail.days.length - 1].trade_date)}` : avail ? '—' : 'checking…'}</dd>
                </dl>
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
                {local
                  ? <button type="button" className="qlink" style={{ justifySelf: 'start' }} onClick={() => { setLocal(null); sent.current.clear(); setRequest({ from: '', to: '' }); }}>Use the stored Supabase data instead</button>
                  : <label className="qlink" style={{ cursor: 'pointer', justifySelf: 'start' }}>Load day files from this computer<input type="file" accept=".gz" multiple className="sr" onChange={(e) => pickFiles(e.target.files)} /></label>}
                <p className="sec-note">Only NIFTY options are stored. Other underlyings, stocks and futures are not supported on real data yet.</p>
              </>
            ) : (
              <>
                {inSec('data').map((f) => field(f))}
                <dl className="ro">
                  <dt>Model</dt><dd>{slug === 'fourleg' ? 'Four imaginary stocks, daily, monthly options' : 'An imaginary NIFTY-like index, 1-minute; realised vol 12%'}</dd>
                  <dt>Dates</dt><dd>in 2099, so they cannot be mistaken for history</dd>
                </dl>
              </>
            )}
          </Section>

          <Section id="period" letter="C" title="Backtest period" summary={sectionSummary.period} open={open.has('period')} onToggle={() => toggleSec('period')} errors={periodErrors} warns={periodWarn ? 1 : 0} dim={dim('period')}>
            {real ? (
              inventory.length
                ? <Calendar inventory={inventory} statuses={statusRows} source={local ? 'local' : 'dhan'} series={flag} request={request} onChange={setRequest} range={range} outcomes={outcomes} />
                : <p className="sec-note">{!local && !avail ? 'Checking which days are stored…' : 'The calendar opens once stored days are available (see Market data).'}</p>
            ) : (
              <>
                {inSec('period').map((f) => field(f))}
                <p className="sec-note">Synthetic sessions are generated from the seed. Pick Real NIFTY under Market data to choose calendar dates.</p>
              </>
            )}
          </Section>

          <Section id="risk" letter="D" title="Capital & risk" summary={sectionSummary.risk} open={open.has('risk')} onToggle={() => toggleSec('risk')} changed={changedIn('risk')} dim={dim('risk')}>
            {slug === 'fourleg' ? <p className="sec-note">The four-leg model sizes three short lots against the protective lots (Strategy) and uses its own synthetic margin. It has no account settings.</p> : (
              <>
                {inSec('risk').filter((f) => f.key === 'capital' || f.key === 'lots').map((f) => field(f))}
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
                <div className="sub-h">Margin <span className="est2">estimated</span></div>
                {inSec('risk').filter((f) => f.key !== 'capital' && f.key !== 'lots').map((f) => field(f))}
              </>
            )}
          </Section>

          <Section id="execution" letter="E" title="Execution" summary={sectionSummary.execution} open={open.has('execution')} onToggle={() => toggleSec('execution')} changed={changedIn('execution')} warns={real && slip === 0 ? 1 : 0} dim={dim('execution')}>
            {slug === 'fourleg' ? <p className="sec-note">This model charges ₹20 an order plus statutory charges at fixed rates inside the model. It has no execution settings.</p> : (
              <>
                {inSec('execution').map((f) => field(f, f.key === 'slip_pct' && real && slip === 0 ? 'Zero slippage on real candles overstates results.' : null))}
                <dl className="ro">
                  <dt>Fills <Tip label="Fill model" text={GLOSSARY.fill_model ?? 'Candle price plus slippage.'} /></dt><dd>Candle price, worsened by the slippage above; stops pay it twice</dd>
                  <dt>Charges <Tip label="Charges" text={GLOSSARY.charges ?? 'Statutory charges.'} /></dt><dd>STT, exchange, SEBI, stamp and GST at the rates in force on each trade date</dd>
                  <dt>Order book</dt><dd>None: there is no bid/ask history, so fills are optimistic</dd>
                </dl>
              </>
            )}
          </Section>

          <Section id="advanced" letter="F" title="Advanced" summary={sectionSummary.advanced} open={open.has('advanced')} onToggle={() => toggleSec('advanced')} changed={changedIn('advanced')} dim={dim('advanced')}>
            {inSec('advanced').length ? inSec('advanced').map((f) => field(f)) : <p className="sec-note">This strategy has no advanced settings.</p>}
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
          {real ? (
            <div className="ws-notice" data-kind="real" role="note">
              <span className="stamp2">Real data</span>
              <span>NIFTY 1-minute option candles from Dhan{r?.data ? `, ${shortDate(r.data.from)} to ${shortDate(r.data.to)} (${r.data.days} sessions)` : ''}. <b>Fills are candle prices plus {slip}% slippage, so they are optimistic.</b></span>
              {slug !== 'ema_pullback' && <button type="button" className="qlink" onClick={() => pickSource('synthetic')}>Use synthetic</button>}
              <details><summary>What this assumes</summary>
                <p>There is no bid/ask history, so a real order could fill worse, especially on stops. Expiry dates follow the weekday rule and lot size {r?.data ? r.data.lot_sizes.join('/') : ''} is {r?.data?.lot_source.startsWith('set') ? 'set by you' : 'taken from the day files'} until checked against NSE bhavcopy. Margin is an estimate. Not investment advice.</p>
              </details>
            </div>
          ) : (
            <div className="ws-notice" role="note">
              <span className="stamp2">Synthetic</span>
              <span>Synthetic model, dates in 2099. It shows how a rule reacts to a setting; it is not evidence about NIFTY or any stock. Not investment advice.</span>
              {realOk && <button type="button" className="qlink" onClick={() => { pickSource('real'); showSec('period'); }}>Use real NIFTY data</button>}
            </div>
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
              {(local || avail) && <div className="run-actions">{(local || avail?.state === 'ready') && <button type="button" className="qbtn" onClick={() => showSec('period')}>Open the calendar</button>}{slug !== 'ema_pullback' && <button type="button" className="qbtn" onClick={() => pickSource('synthetic')}>Use the synthetic model</button>}</div>}
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
                    <span>{r.data ? <>Real NIFTY {seriesName} · <b>{shortDate(r.data.from)} – {shortDate(r.data.to)}</b> · {r.data.days} sessions</> : slug === 'fourleg' ? <>Synthetic · <b>{params.months} months</b></> : <>Synthetic · <b>{r.sessions} sessions</b> · seed {String(params.seed)}</>}</span>
                    <span>{nChanged ? `${nChanged} changed from defaults` : 'Default rules'}</span>
                    {cmp && <span>Compared with <b>{cmp.label}</b> · <button type="button" className="qlink" onClick={() => setBaseline(null)}>clear</button></span>}
                    {r.account?.report.generated.run_hash && <span title="Run fingerprint: the same settings and data give the same hash">Run {r.account.report.generated.run_hash.slice(0, 8)}</span>}
                  </div>
                </div>
                <div className="run-actions">
                  <button type="button" className="qbtn" aria-pressed={!!baseline && baseline.key === meta?.key} onClick={() => meta && setBaseline({ label: 'Pinned run', dataKey: meta.dataKey, strategy: r.strategy, m: headline(r), key: meta.key })}>
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
                research={<ResearchPanel r={r} lab={lab} params={params} msPerRun={Math.max(5, lab.ms)} meta={researchMeta} partial={real && range ? range.counts.partial : 0} dataNote={dataNote} onLoad={loadFromStudy} />} />
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
