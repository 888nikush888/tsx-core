import { useLayoutEffect, useState } from "react";
import { useDirtyGuard } from './use-dirty-guard';

export function useVersionedDraft<T>(identity: string, server: T | null, revision: number | string | null, empty: T) {
  const [draft, setDraft] = useState(empty);
  const [base, setBase] = useState<{ identity: string; value: T; revision: number | string | null }>({ identity: "", value: empty, revision: null });
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.value);
  useDirtyGuard(dirty);
  const conflict = Boolean(identity) && base.identity === identity && base.revision !== revision;
  // Seed a newly loaded object before its editable controls are painted.
  useLayoutEffect(() => {
    if (identity === base.identity || (identity && !server)) return;
    const value = server ?? empty;
    setBase({ identity, value, revision });
    setDraft(value);
  }, [identity, server, revision, base.identity, empty]);
  const acceptServer = () => {
    if (!server) return;
    setBase({ identity, value: server, revision });
    setDraft(server);
  };
  const rebase = () => {
    if (server) setBase({ identity, value: server, revision });
  };
  const saved = (value: T, nextRevision: number | string | null) => {
    setBase({ identity, value, revision: nextRevision });
    setDraft(value);
  };
  return { draft, setDraft, dirty, conflict, baseRevision: base.revision, acceptServer, rebase, saved };
}
