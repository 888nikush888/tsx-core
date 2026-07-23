# ADR 0002: Strikte automatische KI-Weiterleitung ohne Human-in-the-loop

- Status: Accepted
- Datum: 2026-07-13

## Kontext

Das Produkt soll KI-Signale automatisch weiterleiten. Freitext, halluzinierte Werte oder stille Provider-Retries würden damit unmittelbar externe Nebenwirkungen auslösen.

## Entscheidung

Es gibt keinen Runtime-Human-in-the-loop. Automatische Weiterleitung ist nur nach exaktem XML-Schema, Allowed-Value-, Zahlen-, Reihenfolge-, LONG/SHORT-Geometrie- und Input-Grounding-Prüfung erlaubt. Provider-Aufrufe haben harte Timeout-, Versuch-, Token- und Tagesbudgets; interne SDK-Retries sind deaktiviert. Modell, Prompt-Hash, Template, Schema, Parser und Nutzung werden als Provenance gespeichert.

## Konsequenzen

Unklare oder abweichende Antworten werden verworfen. Modell-/Prompt-/Template-Releases benötigen ein Live-Golden-Set mit adversarial Cases; Qualitätsabfall ist ein Release-Blocker.

Seit der Trading-Erweiterung verbindet ein persistentes, im Web verwaltbares Schema-Profil das quellspezifische Parser-Template mit einem geprüften ausführbaren XML-Vertrag. Dies ändert die Sicherheitsentscheidung nicht: Profile erlauben keinen beliebigen Code oder neuen Vertragsparser, unbekannte/deaktivierte Profile erzeugen keinen Trade, und ausführbare Paare müssen mit `USD`, `USDC` oder `USDT` notiert sein.
