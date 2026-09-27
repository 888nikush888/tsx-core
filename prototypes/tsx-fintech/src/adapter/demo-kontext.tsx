import { createContext, useContext, useState, type ReactNode } from "react";
import type { SzenarioId } from "@/adapter/memory";
import { setOffline } from "@/adapter/memory";

interface DemoKontext { szenario: SzenarioId; setzeSzenario: (s: SzenarioId) => void; rolle: "admin" | "lesend"; setzeRolle: (r: "admin" | "lesend") => void; demoKonto: string; setzeDemoKonto: (k: string) => void }

const Ctx = createContext<DemoKontext | null>(null);

export function DemoAnbieter({ children }: { children: ReactNode }) {
  const [szenario, setSzenario] = useState<SzenarioId>("normal");
  const [rolle, setzeRolle] = useState<"admin" | "lesend">("admin");
  const [demoKonto, setzeDemoKonto] = useState("paper-1");
  function setzeSzenario(s: SzenarioId) {
    setSzenario(s);
    setOffline(s === "offline");
  }
  return <Ctx.Provider value={{ szenario, setzeSzenario, rolle, setzeRolle, demoKonto, setzeDemoKonto }}>{children}</Ctx.Provider>;
}

export function useDemo(): DemoKontext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDemo ausserhalb des Anbieters");
  return v;
}
