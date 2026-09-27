import { useCallback, useEffect, useState } from "react";

export function useRoute(): [string, (ziel: string) => void] {
  const lesen = () => window.location.hash.replace(/^#/, "") || "/uebersicht";
  const [pfad, setPfad] = useState(lesen);
  useEffect(() => {
    const f = () => setPfad(lesen());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const gehen = useCallback((ziel: string) => { window.location.hash = ziel; }, []);
  return [pfad, gehen];
}

export function passt(route: string, pfad: string): Record<string, string> | null {
  const r = route.split("/").filter(Boolean);
  const p = pfad.split("?")[0].split("/").filter(Boolean);
  if (r.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(":")) params[r[i].slice(1)] = decodeURIComponent(p[i]);
    else if (r[i] !== p[i]) return null;
  }
  return params;
}
