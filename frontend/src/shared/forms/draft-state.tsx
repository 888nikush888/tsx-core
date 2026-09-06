export function DraftState({ label, form, server }: { label: string; form: { dirty: boolean; conflict: boolean; draft: unknown; acceptServer: () => void; rebase: () => void }; server: unknown }) {
  if (!form.dirty && !form.conflict) return null;
  return <section aria-label={`${label} Entwurf`} className="operations-card"><p role="status">{label}: {form.dirty ? 'Ungespeicherte Änderungen' : 'Unveränderter Entwurf'}. {form.conflict && 'Serverstand geändert. Speichern ist bis zum Vergleich gesperrt.'}</p>
    {form.conflict && <><details><summary>Entwurf und Server vergleichen</summary><p>Entwurf</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(form.draft, null, 2)}</pre><p>Server</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(server, null, 2)}</pre></details><button type="button" className="secondary-button" onClick={form.acceptServer}>Serverstand übernehmen</button><button type="button" className="secondary-button" onClick={form.rebase}>Entwurf bewusst auf neuen Stand anwenden</button></>}
  </section>;
}
