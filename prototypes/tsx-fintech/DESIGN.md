# TSX Fintech-Prototyp — Designgrundlage (Phase A)

Gilt nur fuer den backendlosen Prototyp in `prototypes/tsx-fintech/`.
Preset `buFywKm`, aufgeloest mit shadcn-CLI 4.21.0: Style **lyra** (Base UI),
Farben **neutral**, Font **Inter Variable** (Ueberschriften erben),
Icons **Lucide**, Radius **Standard**, Menues dezent, Charts neutral.
Siehe `docs/frontend-rebuild/preset.json`.

## 1. Haltung

Ruhige Arbeitsoberflaeche fuer Trading-Automatisierung, keine Marketingseite.
Deutsch als UI-Sprache, technische Parameternamen als Zweitinfo.
Weniger Klicks, gleiche Funktionen: 7 Aufgabenbereiche statt Dienstnamen.

## 2. Tokens (Preset, keine Zweittokens)

- Semantische Tokens aus `src/index.css`: `background/foreground`, `card`,
  `primary/secondary/muted/accent`, `border/input/ring`, `destructive`,
  `chart-1…5`, `sidebar-*`. Keine Rohwerte in Komponenten.
- Radius: `--radius` + abgeleitete Stufen. Keine Schatten-Deko, keine Verlaeufe,
  kein Glassmorphism.
- Statusfarben nur als Traeger von Zustand (.ok/warnung/fehler/info), nie als Deko.

## 3. Typografie (Inter Variable, eine Familie)

- Display + Body: Inter Variable. Ueberschriften erben (`font-heading: inherit`).
- Groessen: Seitentitel 20/600, Kartentitel 14/600, Body 14, Labels 12–13,
  Sekundaerinfo 12. Keine 8–10-px-Fliesstexte.
- Zahlen: `tabular-nums`, Einheit + Waehrung immer dabei, keine
  Praezisionsveraenderung durch Formatierung, keine Waehrungsaggregation
  ohne Umrechnung.
- Helle und dunkle Modi aus Preset-Tokens (`.dark`-Klasse). Farbe nie als
  einziger Informationstraeger. Tastaturfokus sichtbar, `prefers-reduced-motion`
  respektiert.

## 4. Layout

- `TsxAppShell`: links Sidebar (7 Bereiche + globale Suche + Szenariowaehler),
  oben ruhiger Kopf (Umgebung/Paper-Live, Kontokontext, Verbindung,
  Speicherzustand, Handlungsbedarf), Content max. 1280px.
- Vorlagen: `DashboardPage`, `ListPage`, `SettingsPage`, `DetailPage`,
  `BuilderPage`. Keine Bereichs-Sonderlayouts.
- Tabellen scrollen kontrolliert horizontal innen; Charts haben feste
  Containerhoehe; Canvas hat expliziten Viewport (Tools/Eigenschaften
  ordnen sich schmal um).
- Keine Fehlerverstecke: kein globales `overflow:hidden`, keine Negativabstaende,
  keine z-index-Leitern ausserhalb von Bibliotheks-Overlays.

## 5. Interaktion und Simulation (alles lokal)

- Autosave-Sprache: eingegeben → gueltig → gespeichert → wirksam →
  (ggf. nach Neustart) → freigegeben. „Gespeichert“ ≠ „aktiv“.
- Entprellung 500–800ms/Fokuswechsel/Auswahlabschluss; gekoppelte Felder
  atomar; keine Toast-Flut.
- Risiko-/Befehlsaktionen (Live-Aktivierung, Orders, Freigaben, Rotation,
  Restore, Loeschen, Neustart, Kill-Switch) sind explizite Bestaetigungs-
  ablaeufe und wirken nur auf lokale Beispieldaten.
- Szenariowaehler (nur Vorschau): normal, leer, laedt, Validierungsfehler,
  ausstehende Aenderung, gespeichert, Konflikt, Netzwerkunterbrechung,
  fehlende Berechtigung, ausstehende Freigabe, gefaehrliche Aktion — plus
  Reset. Veraendert kein Layout, kommt nicht ins Produkt.
- Dauer-Banner: „Designvorschau – ausschliesslich Beispieldaten – keine
  echten Aktionen“. Demo-Rollen/Konten sind nie mit Echtzustand zu
  verwechseln.

## 6. Abgrenzung

- Keine Backend-/Börsen-/Telegram-/Auth-/Telemetrie-Requests (Nachweis via
  Playwright-Netzwerkpruefung; erlaubt: Preview-Assets, Dev-HMR).
- Keine `.env`, keine Secrets, keine Sessions. Secrets in Fixtures sind
  Platzhalter ohne Wert (`••••`), write-only mit Status + Ersetzen/Rotieren.
- Alte Produktregeln (dark-ops, Geist, Micro-Typo, „never redesign away“)
  sind inventarisiert, aber fuer diese Vorschau nicht bindend.
