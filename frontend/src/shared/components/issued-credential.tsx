import { useSyncExternalStore } from "react";

type IssuedCredential = { label: string; token: string };
let pending: IssuedCredential[] = [];
const listeners = new Set<() => void>();
export function showIssuedCredential(label: string, token: string) {
  pending = [...pending, { label, token }];
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Lives outside the authentication gate so a failed follow-up read cannot discard the confirmed response. */
export function IssuedCredentialNotice() {
  const credential = useSyncExternalStore(subscribe, () => pending[0] ?? null);
  if (!credential) return null;
  return <section role="region" aria-label="Einmaliger Zugangsschlüssel" className="border-2 border-primary bg-background p-6 relative z-50">
    <h2>{credential.label} · jetzt sicher speichern</h2><p>Ausstellung bestätigt. Dieser Wert bleibt bis zu deiner Bestätigung sichtbar, auch wenn das Nachladen oder die Anmeldung fehlschlägt.</p>
    <code className="block break-all py-3 select-all">{credential.token}</code><div className="flex flex-wrap gap-3">
      <button className="secondary-button" onClick={() => void navigator.clipboard.writeText(credential.token)}>Zugangsschlüssel kopieren</button>
      <button className="primary-button" onClick={() => { pending = pending.slice(1); for (const listener of listeners) listener(); }}>Sicher gespeichert · Anzeige schließen</button>
    </div>
  </section>;
}
