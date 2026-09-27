# Verifikation — Phase A (tatsaechlich ausgefuehrt)

- Basis-SHA: `5d3a3c7995e088aa9a46cfe815b89fe958ec6765` (origin/main, 27.09.2026).
- Preset: `npx shadcn@latest preset decode buFywKm --json` (CLI 4.21.0) → style lyra,
  neutral, inter, lucide, default-radius. `preset.json` abgelegt, Projektabgleich erfolgt.
- Skills: `frontend-design` (lokal, Apache-2.0-Lizenz geprueft) und `shadcn`-Skill
  (lokal) gelesen und angewendet; `npx skills add`-Installer steht in dieser Umgebung
  nicht zur Verfuegung — stattdessen Skill-Dateien direkt geprueft und CLI/MCP-Werkzeuge
  direkt genutzt (dokumentierte Abweichung, keine Funktionsluecke).
- shadcn-MCP: kein lauffaehiger MCP-Server in dieser Umgebung vorhanden; stattdessen
  offizielle CLI (`init -p buFywKm`, `add`, 30 Komponenten) + Registry-Doku verwendet.
  Komponentenabfrage funktional nachgewiesen (Button + 29 weitere installiert).
- Build: `tsc -b && vite build` gruen (strict). Tests: 9/9 Vitest gruen. Lint: oxlint ohne Befund.
- Screenshots: 40 Routen × (1280 + 390), visuell geprueft (Uebersicht, Konten, Builder,
  MCP, Komponenten, schmal). Artefakte: `prototypes/tsx-fintech/shots/`.
- Netzwerk: 0 Fremd-Requests, nur Preview-Assets (kein HMR im Preview-Build).
  Nachweis: `shots/netzwerk.json`.
- Isolation: Produktcode unveraendert — einziger Diff-Pfad ist `prototypes/` + `docs/frontend-rebuild/`
  auf eigenem Branch (Nachweis via `git status`/`git diff --stat` vor Uebergabe).
- Dark Mode: `.dark`-Tokens + Umschalter vorhanden.
- axe: @axe-core/playwright ist installiert; automatisierter axe-Lauf steht noch aus
  (offen, kein Bestanden behauptet). Manuell geprueft: Fokus sichtbar, Dialogtitel,
  Labels, Tastaturpfade, keine Clipping-Fehler auf 1280/390.
- Node-Laufzeit lokal: v24.14.1 (Prototyp-only; Produkt verlangt Node 22) — dokumentiert,
  kein Produktiv einfluss.

## Einschraenkungen (ehrlich)

- Kein MCP-Server- und kein Skills-CLI-Funktionsnachweis moeglich (s. o.).
- Kein oeffentlicher Preview-Host genannt (entfernte Umgebung) — ZIP + lokale Anleitung stattdessen.
- axe-Automatisierung und 200-%-Zoomtest stehen aus.
