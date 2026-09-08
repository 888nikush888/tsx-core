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

export interface WorkflowSimulationEvidence {
  error?: string;
  active?: boolean;
  paths?: SimulationPath[];
  revisionId?: string;
  revision?: number;
  warnings?: string[];
}

function routeGroups(paths: SimulationPath[]) {
  const groups = new Map<string, SimulationPath[]>();
  for (const path of paths) {
    const key = path.routeGroupKey || path.id;
    const group = groups.get(key) || [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups].map(([key, paths]) => ({ key, paths: paths.toSorted(
    (left, right) => (left.fallbackRank ?? 0) - (right.fallbackRank ?? 0),
  ) }));
}

function routeLetter(index: number): string {
  return String.fromCodePoint(65 + Math.min(index, 25));
}

function SimulationRouteGroup({ paths }: Readonly<{ paths: SimulationPath[] }>) {
  return <section className="operations-card">
    <strong>{paths.map(path => path.accountId).join(" → ")}</strong>
    {paths.slice(0, -1).map((path, index) => <small key={path.id}>
      {routeLetter(index)}→{routeLetter(index + 1)}: {fallbackPolicyShortLabel(path.fallbackOn)}
    </small>)}
  </section>;
}
function pathDecision(path: SimulationPath) {
  return {
    passed: path.allowed && path.enabled,
    reason: path.reason || (path.enabled ? "Filter erfüllt" : "Konto nicht bereit"),
  };
}
function SimulationPathResult({ path }: Readonly<{ path: SimulationPath }>) {
  const { passed, reason } = pathDecision(path);
  return <div className={passed ? "pass" : "blocked"}>
    <span>{passed ? "PASS" : "BLOCK"}</span>
    <strong>{path.accountId}</strong>
    <small>{reason}</small>
  </div>;
}

export function WorkflowSimulationResult({ result }: Readonly<{ result: WorkflowSimulationEvidence }>) {
  if (result.error) {
    return <div className="builder-error" role="alert">{result.error}</div>;
  }
  const paths: SimulationPath[] = Array.isArray(result.paths) ? result.paths : [];
  if (paths.length === 0) {
    return <div className="operations-empty">Für diesen Kanal existiert kein vollständiger Pfad.</div>;
  }
  return (
    <>
      {routeGroups(paths).map(group => <SimulationRouteGroup key={group.key} paths={group.paths} />)}
      {paths.map(path => <SimulationPathResult key={path.id} path={path} />)}
      <p className="operations-help">Nur aktuelle, reine Vorschau – Zustand kann sich bis zur Ausführung ändern.</p>
    </>
  );
}
