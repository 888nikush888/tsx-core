# Prototyp-Review — TSX Fintech (Phase A)

- Preview-ID: `tsx-fintech-a1`
- Basis: `origin/main` = `5d3a3c7995e088aa9a46cfe815b89fe958ec6765`
- Branch: `prototype/tsx-fintech-phase-a`
- Build-Kennung: `dist/` aus `npm run build` (Vite 7.3.6, strict-TS, oxlint sauber, 9/9 Vitest gruen).
- Preset: `buFywKm` (base-lyra, neutral, Inter Variable, Lucide, Standard-Radius), CLI 4.21.0.
- Start lokal: `npm run preview --prefix prototypes/tsx-fintech -- --port 4174 --host 127.0.0.1`
  (oder ein beliebiger statischer Dateiserver auf `prototypes/tsx-fintech/dist/`).
  Nur Beispieldaten, keine Backend-Verbindung.

## Umfang

40 Routen in 8 Bereichen (Uebersicht, Trading, Automationen, Signale & Integrationen,
Risiko & Analyse, Betrieb, Einstellungen, Systemseiten) + `/preview/components`.
Alle 5 Vorlagen (Dashboard/List/Settings/Detail/Builder) werden je mehrfach verwendet.
315 Parameter sind `parameter-coverage.json` Zielrouten zugeordnet; 8 Beispielparameter
sind als echte Bedienelemente umgesetzt, der Rest ist ueber den Katalog auffindbar.
139 API-Routen sind inventarisiert (keine Anbindung in Phase A).
10 Parameter sind als echte Bedienelemente umgesetzt (Katalog-Auszug mit 8 Beispielen
+ 7 Autosave-Felder auf Viewer-/Zugriff-/System-/Adaptiv-Seiten, teils ueberlappend);
alle 315 haben eine zugeordnete Zielroute, der Rest folgt mit der Backend-Anbindung.

## Bedienablaeufe (simuliert)

Navigation mit Zurueck/Vorwaerts, globale Suche (deutsch + technisch), Tabellen
(Filter/Sortierung/Pagination), Formulare mit Validierung + Autosave
(500–800 ms, Revision, Konflikt, Offline), MCP-Genehmigen/Ablehnen,
Order-Storno und Recovery mit Bestaetigung, Workflow-Builder (echter
React-Flow-Canvas: verschieben, auswaehlen, Entwurf editieren),
Szenariowaehler (11 Zustaende) + Reset, Hell/Dunkel-Umschalter.

## Was simuliert wird

Alle Daten, Speicherungen (Revision/Readback), Freigaben, Charts, Logs,
Backups, KI-Antworten. Kein Request ausser Preview-Assets (Nachweis:
`shots/netzwerk.json` — 0 fremde Requests, 0 Konsolenfehler).
Secrets nur als Platzhalter (write-only).

## Offene Designpunkte

- Chunk-Groesse index.js ~607 KB (Demo-Build, keine Produktivforderung).
- Vollstaendige 315-Felder-Belegung erfolgt erst mit Backend-Anbindung (Phase B).
- Echte Autorisierung, Persistenz, Streams und Container-Auslieferung gehoeren zu Phase B.
