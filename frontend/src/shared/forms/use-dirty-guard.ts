import { useEffect } from 'react';

export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: Event) => { event.preventDefault(); };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('tsx:navigation-check', navigate);
    return () => { window.removeEventListener('beforeunload', leave); window.removeEventListener('tsx:navigation-check', navigate); };
  }, [dirty]);
}
