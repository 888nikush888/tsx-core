import type { WorkflowFallbackReason } from "./types";
import { fallbackPolicyShortLabel } from "./workflow-fallback-policy";

type SimulationPath = {
  id: string;
  accountId: string;
  routeGroupKey?: string;
  fallbackRank?: number;
  fallbackOn?: WorkflowFallbackReason[];
  enabled: boolean;
  allowed: boolean;
  reason?: string;
};

function routeGroups(paths: SimulationPath[]): SimulationPath[][] {
  const groups = new Map<string, SimulationPath[]>();
  for (const path of paths) {
    const key = path.routeGroupKey || path.id;
    const group = groups.get(key) || [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => group.sort(
    (left, right) => (left.fallbackRank ?? 0) - (right.fallbackRank ?? 0),
  ));
}

function routeLetter(index: number): string {
  return String.fromCharCode(65 + Math.min(index, 25));
}

export function WorkflowSimulationResult({ result }: Readonly<{ result: any }>) {
  if (result.error) {
    return <div className="builder-error" role="alert">{result.error}</div>;
  }
  const paths: SimulationPath[] = Array.isArray(result.paths) ? result.paths : [];
  if (paths.length === 0) {
    return <div className="operations-empty">Für diesen Kanal existiert kein vollständiger Pfad.</div>;
  }
  return (
    <>
      {routeGroups(paths).map((group) => (
        <section className="operations-card" key={group[0].routeGroupKey || group[0].id}>
          <strong>{group.map((path) => path.accountId).join(" → ")}</strong>
          {group.slice(0, -1).map((path, index) => (
            <small key={path.id}>
              {routeLetter(index)}→{routeLetter(index + 1)}: {fallbackPolicyShortLabel(path.fallbackOn)}
            </small>
          ))}
        </section>
      ))}
      {paths.map((path) => {
        const passed = path.allowed && path.enabled;
        const reason = path.reason || (path.enabled ? "Filter erfüllt" : "Konto nicht bereit");
        return (
          <div key={path.id} className={passed ? "pass" : "blocked"}>
            <span>{passed ? "PASS" : "BLOCK"}</span>
            <strong>{path.accountId}</strong>
            <small>{reason}</small>
          </div>
        );
      })}
      <p className="operations-help">Nur aktuelle, reine Vorschau – Zustand kann sich bis zur Ausführung ändern.</p>
    </>
  );
}
