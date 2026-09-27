// In-Memory-Datenadapter (nur Vorschau): simuliert Speichern mit Verzoegerung,
// Revisionen, Konflikte und Offline-Zustand. Keine Netzwerkaufrufe.
export type SaveState = "ruhig" | "eingegeben" | "speichert" | "gespeichert" | "ungueltig" | "konflikt" | "offline";

export interface SaveResult { ok: boolean; revision: number; wirksam: boolean; konflikt?: boolean }

let revision = 7;
let offline = false;
let naechsterKonflikt = false;

export function setOffline(wert: boolean) { offline = wert; }
export function isOffline(): boolean { return offline; }
export function conflictBeimNaechstenSpeichern() { naechsterKonflikt = true; }
export function aktuelleRevision(): number { return revision; }

export function speichern(daten: Record<string, unknown>, verzoegerungMs = 600): Promise<SaveResult> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      if (offline) { resolve({ ok: false, revision, wirksam: false }); return; }
      if (naechsterKonflikt) {
        naechsterKonflikt = false;
        resolve({ ok: false, revision, wirksam: false, konflikt: true }); return;
      }
      revision += 1;
      void daten;
      resolve({ ok: true, revision, wirksam: true });
    }, verzoegerungMs);
  });
}

export type SzenarioId = "normal" | "leer" | "laedt" | "validierung" | "ausstehend" | "gespeichert" | "konflikt" | "offline" | "berechtigung" | "freigabe" | "gefahr";

export const SZENARIEN: { id: SzenarioId; label: string; beschreibung: string }[] = [
  { id: "normal", label: "Normal", beschreibung: "Regelbetrieb mit Beispieldaten." },
  { id: "leer", label: "Leer", beschreibung: "Keine Datensaetze, leere Zustaende." },
  { id: "laedt", label: "Laedt", beschreibung: "Ladeplatzhalter statt Inhalten." },
  { id: "validierung", label: "Validierungsfehler", beschreibung: "Formulare zeigen Feldfehler." },
  { id: "ausstehend", label: "Ausstehende Aenderung", beschreibung: "Ungespeicherte Eingaben sichtbar." },
  { id: "gespeichert", label: "Gespeichert", beschreibung: "Erfolgsbestaetigung nach Speichern." },
  { id: "konflikt", label: "Konflikt", beschreibung: "Serverseitige Aenderung, Aufloesung noetig." },
  { id: "offline", label: "Netzunterbrechung", beschreibung: "Verbindung getrennt, Warteschlange." },
  { id: "berechtigung", label: "Fehlende Berechtigung", beschreibung: "Aktionen gesperrt mit Begruendung." },
  { id: "freigabe", label: "Ausstehende Freigabe", beschreibung: "Entwurf wartet auf Genehmigung." },
  { id: "gefahr", label: "Gefaehliche Aktion", beschreibung: "Bestaetigungsablauf mit Wirkungsvorschau." },
];
