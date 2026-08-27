import { ArrowRight, Focus, GitBranch, GitMerge, Route } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WorkflowRoute, WorkflowRouteTopology } from "./workflow-routes";

type RouteOverviewProps = {
  open: boolean;
  topology: WorkflowRouteTopology;
  selectedPathId: string | null;
  onOpenChange: (open: boolean) => void;
  onFocusPath: (pathId: string | null) => void;
};

function RouteSequence({ route }: { route: WorkflowRoute }) {
  const orderedAccounts = route.fallbackAccounts.map((candidate) => candidate.accountName);
  return (
    <div className="route-sequence" aria-label={`Pfad ${route.channelName} zu ${route.accountName}`}>
      <strong>{route.channelName}</strong>
      <ArrowRight aria-hidden="true" />
      <span>{route.nodeIds.length - 2} Verarbeitungsschritte</span>
      <ArrowRight aria-hidden="true" />
      <strong>{orderedAccounts.join(" → ")}</strong>
    </div>
  );
}

export function RouteOverview({
  open,
  topology,
  selectedPathId,
  onOpenChange,
  onFocusPath,
}: RouteOverviewProps) {
  const focus = (pathId: string | null) => {
    onFocusPath(pathId);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="route-overview-panel"
      >
        <DialogHeader>
          <Badge variant="secondary">
            <Route /> Routing
          </Badge>
          <DialogTitle>Kanäle, Verarbeitung und Börsen</DialogTitle>
          <DialogDescription>
            Die Matrix zeigt verbindlich, welche exklusive Kontoreihenfolge ein
            Signal verwendet. Fallback-Konten werden nur versucht, wenn das Paar
            auf dem vorherigen Konto nicht verfügbar ist.
          </DialogDescription>
        </DialogHeader>
        <div className="route-overview-content">
          <Alert>
            <GitBranch />
            <AlertTitle>Die Verbindungen bestimmen die Ausführung</AlertTitle>
            <AlertDescription>
              Zusammengeführte Kanäle teilen alle folgenden Abzweigungen. Für
              eine feste Kanal-zu-Konto-Zuordnung werden getrennte Knotenpfade
              angelegt; dieselbe veröffentlichte Regex- oder Parser-Version kann
              in mehreren Pfaden wiederverwendet werden.
            </AlertDescription>
          </Alert>

          {topology.crossProducts.map((group) => (
            <Alert key={group.id} className="route-cross-product-alert">
              <GitMerge />
              <AlertTitle>
                Vollständige Verteilung: {group.channelCount} Kanäle ×{" "}
                {group.accountCount} Konten
              </AlertTitle>
              <AlertDescription>
                {group.channels.join(", ")} laufen gemeinsam durch{" "}
                {group.sharedNodes.join(", ")} und erreichen deshalb{" "}
                {group.accounts.join(", ")}. Ergebnis: {group.routeCount}{" "}
                Ausführungspfade.
              </AlertDescription>
            </Alert>
          ))}

          <Card size="sm" className="route-matrix-card">
            <CardHeader>
              <CardTitle>Kanal × Börsenkonto</CardTitle>
              <CardDescription>
                Klicke eine belegte Zelle an, um den zugehörigen Pfad auf dem
                Canvas hervorzuheben.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {topology.routes.length === 0 ? (
                <p className="route-empty">Noch kein vollständiger Pfad.</p>
              ) : (
                <div className="route-matrix-scroll">
                  <table aria-label="Kanal-zu-Konto-Matrix">
                    <thead>
                      <tr>
                        <th scope="col">Kanal</th>
                        {topology.accounts.map((account) => (
                          <th scope="col" key={account.id}>
                            <strong>{account.name}</strong>
                            <small>{account.detail}</small>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {topology.channels.map((channel) => (
                        <tr key={channel.id}>
                          <th scope="row">
                            <strong>{channel.name}</strong>
                            <small>{channel.id}</small>
                          </th>
                          {topology.accounts.map((account) => {
                            const entry = topology.matrix.find(
                              (cell) =>
                                cell.channelId === channel.id &&
                                cell.accountId === account.id,
                            );
                            const route = entry?.routes[0];
                            const fallbackRank = route?.fallbackAccounts.find(
                              (candidate) => candidate.accountId === account.id,
                            )?.rank;
                            return (
                              <td key={account.id}>
                                {route ? (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant={
                                      entry.routes.some(
                                        (item) => item.id === selectedPathId,
                                      )
                                        ? "default"
                                        : "secondary"
                                    }
                                    aria-label={`${channel.name} auf ${account.name} hervorheben`}
                                    onClick={() => focus(route.id)}
                                  >
                                    {fallbackRank === undefined || route.fallbackAccounts.length === 1
                                      ? entry.routes.length > 1 ? `${entry.routes.length} Pfade` : "direkt"
                                      : `${fallbackRank + 1}. Wahl`}
                                  </Button>
                                ) : (
                                  <span aria-label="Keine Ausführung">—</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <section className="route-list" aria-labelledby="route-list-title">
            <div className="route-list-heading">
              <div>
                <h3 id="route-list-title">Kompilierte Pfade</h3>
                <p>Jeder Eintrag kann höchstens eine Kontoausführung erzeugen.</p>
              </div>
              {selectedPathId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => focus(null)}
                >
                  Fokus lösen
                </Button>
              )}
            </div>
            {topology.routes.map((route, index) => (
              <Card
                size="sm"
                key={route.id}
                className={
                  route.id === selectedPathId ? "route-card is-selected" : "route-card"
                }
              >
                <CardContent>
                  <div className="route-card-index">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <Badge variant={route.enabled ? "outline" : "secondary"}>
                      {route.enabled ? "ausführbar" : "inaktiv"}
                    </Badge>
                  </div>
                  <RouteSequence route={route} />
                  <div className="route-card-detail">
                    <span>Strategie: {route.strategyName}</span>
                    <span>
                      {route.fallbackAccounts.length > 1
                        ? `Exklusive Reihenfolge: ${route.fallbackAccounts.map((candidate, candidateIndex) => `${candidateIndex + 1}. ${candidate.accountName}`).join(" · ")}`
                        : route.accountDetail}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant={
                      route.id === selectedPathId ? "secondary" : "outline"
                    }
                    size="sm"
                    onClick={() => focus(route.id)}
                  >
                    <Focus data-icon="inline-start" /> Auf Canvas zeigen
                  </Button>
                </CardContent>
              </Card>
            ))}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
