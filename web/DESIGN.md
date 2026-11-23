# Straddloop: design system

## The world
**A trader's blotter, printed.** Warm paper, ink borders, crisp offset shadows, a rubber stamp that
says SYNTHETIC. The site looks like a ledger that someone checks every evening, not a fintech
dashboard. The hard-offset shadow is deliberate: it is the "printed sheet lifted off the desk"
device of this world, so every element that carries one has
`data-impeccable-ignore="hard-offset-shadow"`.

Anti-references: purple-to-blue gradients, glass cards, dark "terminal" trading UIs, neon green
on black, stock photos of candlestick screens.

## Colour (OKLCH)
| Token | Value | Use |
|---|---|---|
| `--paper` | `oklch(0.967 0.012 92)` | page |
| `--paper-2` | `oklch(0.93 0.018 92)` | recessed bands, table stripes |
| `--card` | `oklch(0.992 0.004 92)` | sheets |
| `--ink` | `oklch(0.19 0.02 265)` | text, borders, shadows |
| `--ink-2` | `oklch(0.43 0.02 265)` | secondary text |
| `--cobalt` | `oklch(0.48 0.21 264)` | the one brand colour: links, primary action, chart line |
| `--marker` | `oklch(0.9 0.16 98)` | highlighter: one phrase per view, selected state |
| `--gain` | `oklch(0.5 0.14 152)` | positive P&L only |
| `--loss` | `oklch(0.54 0.2 27)` | negative P&L only |

Green and red never decorate. They only mean profit and loss, and always travel with a sign.

## Type
* **Archivo** (variable, width axis). Display: weight 800, width 112%, tracking −0.035em.
  Body: weight 400–500, width 100%.
* **IBM Plex Mono** for every figure, time, parameter key and label. `tabular-nums`.
* Scale: display `clamp(2.75rem, 7.2vw, 6.25rem)`, h2 `clamp(1.9rem, 3.8vw, 3.1rem)`,
  h3 `1.35rem`, body `1.0625rem/1.6`, small `0.875rem`, label `0.75rem` mono uppercase +0.08em.
* Measure: prose capped at 62ch.

## Space
4px base. Steps: 4, 8, 12, 16, 24, 32, 48, 72, 112. Section rhythm is 112px desktop / 72px mobile.
**A heading always has more space above it than below it** (h2: section gap above, 16–24 below;
h3: 32 above, 8 below). Gutter: `clamp(16px, 4vw, 48px)`; max content width 1200px.

Horizontal card rows scroll edge to edge, with the gutter as padding at **both** ends and
`scroll-padding-inline` to match, so the first and last card sit clear of the edge.

## Shape
* Border: 2px ink. Radius: 6px on sheets and controls, 999px on pills.
* Shadow: `5px 5px 0 var(--ink)` on sheets, `3px 3px 0` on controls. No blur, ever.
* Pressing a control moves it into its shadow (translate 3px, shadow 0).

## Motion
* 160ms for presses and hovers, 420ms for reveals, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
* Equity lines draw left to right once (the result arriving). Figures count up once.
* Sections rise 14px and fade in on first scroll into view. Nothing loops except the fact ticker.
* `prefers-reduced-motion`: everything appears in its final state; the ticker stops.

## Components
Sheet (card), Button (primary cobalt, secondary paper, quiet text), Pill, Stamp, Figure (mono
number with sign and colour), Stepper, Segmented control, Range field, EquityChart, PayoffChart,
Sparkline, Callout (the synthetic notice), Empty state (says what will appear and gives the one
action that fills it).

## Onboarding rules
Value before account. Four short steps, one decision each, progress always visible, back always
possible. The first backtest runs inside the flow. Sign-up is offered after the result, as the way
to keep it, never as a gate.

## Workspace (the Lab)
**The ledger, at instrument grade.** The Lab is a working surface, not a page: a configuration rail beside a
full-width results area. Source: `app/lab/lab.css`, components in `components/lab/`.

- **Ruled, not boxed.** Sections and figures are separated by hairline rules (`--rule`, `--rule-2`) and one
  1.5px ink rule under each block heading. Only floating layers (tooltips, the mobile drawer) and the Run
  button carry the hard offset shadow.
- **Tokens** (in `globals.css`): `--canvas` (results ground), `--rail` (settings ground), `--rule`, `--rule-2`,
  `--hover`, `--select-bg`; type steps `--t-xs` to `--t-lg`; radii `--r-sm` 4px and `--r` 6px; motion
  `--dur-1` 140ms (hover, toggles) and `--dur-2` 220ms (sections, drawer, panels).
- **Rail.** 336–400px (`clamp(336px, 25vw, 400px)`), sticky under the 56px app bar, its own scroll, sections
  A–F (Strategy & legs, Entry & exit, Risk rules, Data & period, Capital & execution, Advanced), each split
  under sub-headings (`SUBGROUP` in `lib/labSections.ts`). Each section header
  states what is set inside it and badges what changed, what must be fixed and what needs a check. The
  footer holds the readiness checks and the Run button, always visible. Desktop collapses it to a 52px
  spine; below 1024px it is a drawer with a scrim and a fixed bottom bar (Settings, Optimise, Run).
- **Fields stay short.** A field shows its default and a reset only once it differs from the default (the
  marker highlight says it changed); four or more choices, or long labels, are a dropdown, not a column of
  radio rows. With every section open the rail is under 3,700px (checked by the e2e test).
- **Times** (`TimeField`): an HH:MM box you can type into, steppers either side, and a grid of times at
  1, 5, 15 or 30 minutes that filters as you type. Each field has the engine's grain (Strategy 01 enters on
  5-minute candles) and bounds; a typed value off either is moved to the nearest allowed time and the
  field says so. Three roles, one mark each, everywhere a time appears: entry a cobalt dot, last new entry
  a marker diamond, square-off an ink square. `SessionLine` puts them on one 09:15–15:30 line; rule times
  the engine fixes are drawn dashed. Out-of-order times block Run and badge the section.
- **Stops and targets** (`LevelField`): the value is typed into a box with its unit beside it (%, pts,
  ₹, ₹/lot, % prem, idx pts), with a unit switch when there is a choice and an On/Off switch when the
  level is optional. The slider is logarithmic over wide ranges (₹100 to ₹10 lakh); arrow keys move by the
  step. Bounds follow what a leg can lose (`lib/levels.ts`): a short leg's stop to 500%, a long leg's
  below 100%.
- **Builder legs** (`LegTable`): one row per leg (side, type, strike rule, size, stop, target), an
  editor under the row, and the engine's own refusals (`legs.validate`, run in the page) listed under
  the table, with the leg marked and Run blocked.
- **Data status** (`DataStatus`): one line above the results (REAL DATA or SYNTHETIC, the series and
  dates, the one caveat that always applies) with the assumptions behind every figure opening below it.
- **Optimiser** (`components/optimise/`): the Optimise button sits beside Run (an outlined ink button; pressed
  while its view is open) and opens a view in the results area, so the rail and the range bar keep working.
  The setup reads top to bottom: what to search (a table with from / to / step per setting), how to judge,
  validation, limits, then **Before it runs** (the estimate) and Start. While a study runs, one boxed progress
  block (determinate bar, count, and a rate only once measured; the indeterminate sheen stops under reduced
  motion). Results: three answer columns ruled like the executive strip, each tagged (leader red *not
  evidence*, out-of-sample cobalt, robust green) with its held-out test in a tinted column; then the checks as
  figures, the compare table and the ranked table. Curves shade training, validation and held-out test as
  bands; comparison lines differ by dash as well as colour.
- **Figures.** Mono, tabular. Green and red are for P&L only; a zero is never red. A figure the engine did
  not produce is an em dash with the reason beside it, never an estimate. Estimated figures carry an
  `EST.` tag.
- **Calendar.** Every day shows its data state (complete, partial, not stored, failed, holiday from the
  unverified list) and the expiry corner; the range comes only from `lib/dateRange.ts`.
- **Motion.** Sections open by animating `grid-template-rows`; panels fade in 4px; nothing moves on
  scroll. `prefers-reduced-motion` turns all of it off.
- **Layout guarantees** (checked by `tests/e2e/lab-ui.cjs` at 1920, 1366, 820 and 390px, and for sideways
  scroll and rail clipping at 1280, 1366, 1440, 1536 and 1920px): no sideways page scroll, nothing cut off
  inside the rail, no scroll boxes inside the results flow (wide tables scroll sideways in place), and the
  page is exactly as tall as the workspace.
