# TSX Fintech-Prototyp starten (nur lokale Designvorschau)

Voraussetzung: Node.js (22 empfohlen, 24 funktioniert lokal) und npm.

## Variante 1: Vorschau des fertigen Builds (empfohlen)

```powershell
cd prototypes/tsx-fintech
npm run preview -- --port 4174 --host 127.0.0.1
```

Dann im Browser oeffnen: http://127.0.0.1:4174/#/uebersicht

## Variante 2: Entwicklungsmodus (mit Hot-Reload)

```powershell
cd prototypes/tsx-fintech
npm install
npm run dev -- --port 5199 --host 127.0.0.1
```

Dann: http://127.0.0.1:5199/#/uebersicht

## Variante 3: ZIP-Paket

`docs/frontend-rebuild/tsx-fintech-a1-preview.zip` entpacken und das enthaltene
`dist/`-Verzeichnis mit einem statischen Dateiserver ausliefern, z. B.:

```powershell
npx serve dist
```

Hinweise: Nur Beispieldaten, keine Backend-Verbindung, keine echten Aktionen.
Alle 40 Routen siehe `docs/frontend-rebuild/feature-coverage.json`.
