# TSX Core — DESIGN.md

Design contract for the Web Control Plane (Workflow Builder / Dashboard / Analytics / Operations). Extracted from the established implementation (`frontend/src/index.css`, shadcn-style primitives). **Direction: dark ops control-plane — dense, precise, calm. Preserve, polish, never redesign away.**

## 1. Identity & Mood
Enterprise trading/automation cockpit. Sharp corners (`--radius: 0.625rem` but components mostly use radius-sm/none), monospace accents for machine data, status communicated by colored dots/badges — never by layout surprises. Premium through precision and density, not decoration.

## 2. Color Tokens
Single source: `:root` / `.dark` in `index.css`. Semantics only — never raw hex:
- Surfaces: `--background`, `--card`, `--builder-surface`, `--builder-surface-strong`
- Text: `--foreground`, `--muted-foreground` (secondary), `--builder-muted`
- Status: green `--builder-green`, danger `--destructive`/`--builder-red`, info `--builder-info`, warning `--builder-warning`
- Charts: `--chart-1…5`
- Accents per workflow node kind: `--node-accent` (set per card)

## 3. Typography
- Sans: "Geist Variable" (everything)
- Machine data / IDs / counts: `ui-monospace` stack at 8–9px, uppercase, letterspaced eyebrows
- Scale: h3 cards 12px/650 · metric value 15–20px/620 · body 10px · micro-labels 8px uppercase
- **Live-updating numerals use `font-variant-numeric: tabular-nums`** (polish layer)

## 4. Spacing & Layout Rhythm
Header rows: topbar 68px → navigation 46px → statusbar/filter rows min-height 48px, all `padding: 0 22px`, separated by 1px `--border`. Content stacks gap 12px; metric grids 4-col (responsive collapse); cards padding 14px.

## 5. Primitives
- Buttons: `primary|secondary|danger|icon-button` (34px, uppercase 10px/650 tracking .08em) + shadcn Button
- Cards: `.operations-card` (14px pad, border, radius-sm)
- Rows: `.gate-row/.event-row/.system-line/.backup-row/.adaptive-row` — grid, border-top separators, hover-tint allowed
- Status dots, state badges (`healthy|danger|muted`), severity chips
- Header bars: `.workflow-statusbar` family — flex, right-aligned tool cluster

## 6. Motion Rules (GPU-only; meaning-first)
Allowed: `transform`, `opacity`, `filter` transitions ≤220ms ease-out.
- Tab indicator slides horizontally on the divider line
- `.spin` = active refresh feedback only
- Loading logo pulse, node connection-ready pulse: state feedback only
- **All animation gated by `prefers-reduced-motion: reduce`** (polish layer enforces globally)
Forbidden: decorative loops, layout-property animation, hover-that-changes-nothing.

## 7. Accessibility Constraints
- Keyboard: full tab path; visible `focus-visible` ring (shadcn default) mandatory on every interactive element
- Contrast: muted-on-card pairs verified ≥ 4.5:1 for body text sizes used
- Status never color-only: dot + label text always paired
- Live regions: `aria-live="assertive"` on incident alerts, `polite` on refresh states
- Reduced motion honored globally

## 8. Accepted Debt
- `operations-panel.tsx` oversized (3.1k LOC) — split pending approval (see audit reports)
- Legacy `console.log` in CLI/banner paths intentional (STDOUT contract)
- No Lighthouse CI gate yet — manual Playwright audits only
