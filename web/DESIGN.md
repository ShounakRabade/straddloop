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
