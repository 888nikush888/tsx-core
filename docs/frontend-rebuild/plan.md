# TSX Frontend-Rebuild — Plan (Phase A)

- Basis: `origin/main` = `5d3a3c7995e088aa9a46cfe815b89fe958ec6765` (Merge-PR #85, Stand 27.09.2026).
- Branch: `prototype/tsx-fintech-phase-a` (Worktree `tmp/tsx-core-proto`), sauber von Basis abgezweigt.
- Phase: A — backendloser, klickbarer Design-Prototyp in `prototypes/tsx-fintech/`.
- Produktcode (`frontend/`, Backend, DB, Deployment) bleibt bis zur Freigabe unveraendert (Git-Diff-Kontrolle).
- Preset: `buFywKm` (lyra / neutral / inter / lucide / default-radius), CLI 4.21.0 — siehe `preset.json`.
- Freigabestatus: `AWAITING_DESIGN_APPROVAL` ist das einzige erlaubte Phasenende. Phase B erst nach
  ausdruecklicher Nutzerfreigabe des konkret vorgelegten Preview-Stands.
- Statusbeleg: `docs/frontend-rebuild/design-approval.json` (initial ohne Freigabe).

## Fortschritt

- [x] Schritt 1 (teilw.): Main-Stand ermittelt, Branch/Worktree angelegt, Skills + Preset geprueft.
- [x] Schritt 1 (Rest): Funktions-/Parameter-/Vertragsinventar aus Repo-Code.
- [x] Schritt 2: Prototyp aufsetzen, Skills/MCP projektlokal pruefen, DESIGN.md (Prototyp).
- [x] Schritt 3: AppShell + Templates (komplexe Settings-Seite, Datentabelle, Workflow-Editor).
- [x] Schritt 4: Alle uebrigen Seiten/Komponenten/Felder/Ablaeufe.
- [x] Schritt 5: Fixtures, Szenariowaehler, Komponentenuebersicht, Lueckenliste.
- [x] Schritt 6: Screenshots, A11y, Netzwerk-/Isolationsnachweis, Preview-Build + Review-Paket.
- [>] Schritt 7 (Vorlage an Nutzer, STOP): Vorlage + STOP mit AWAITING_DESIGN_APPROVAL.
