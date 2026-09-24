import type { ExchangeCatalog } from "./types";

type CatalogEntry = ExchangeCatalog["exchanges"][number];

export function exchangeAssessmentLabel(entry: CatalogEntry): { product: string; decision: string; reasons: string } {
  if (entry.provider === "paper") {
    return { product: "Simulation", decision: "Paper Trading", reasons: "" };
  }
  if (!entry.assessment) {
    return { product: "Ungeprüft", decision: "Keine gebundene CCXT-Einschätzung", reasons: "Bewertung fehlt" };
  }
  const product = entry.assessment.products.length > 0
    ? `CCXT-SDK-Inventur, keine TSX-Handelsfreigabe: ${entry.assessment.products.map((scope) => {
      const [kind, settlement] = scope.split(":");
      const productName = kind === "swap" ? "Swap" : kind === "future" ? "Future" : kind;
      const settlementName = settlement === "linear" ? "linear" : settlement === "inverse" ? "invers" : "Abwicklung ungeklärt";
      return `${productName} (${settlementName})`;
    }).join(" · ")}`
    : "Keine Derivate laut gepinnter CCXT-Inventur";
  const decision = entry.id === "hyperliquid" && entry.assessment.decision === "existing"
    ? "TSX lokal nur first-DEX/USDC/linear/Perp mit Master-Key offline geprüft; Provider-, Konto- und Release-Nachweise offen"
    : entry.assessment.decision === "existing"
      ? "Bestehendes Profil; Produkt- und Provider-Scope gesondert nachweisen"
    : entry.assessment.decision === "not_derivative"
      ? "Keine Futures-Eignung"
      : "Für TSX Core derzeit nicht freigabereif";
  return { product, decision, reasons: entry.assessment.reasonCodes.join(" · ") };
}

export function groupExchangeCatalog(catalog: ExchangeCatalog) {
  const certified = catalog.exchanges.filter((entry) => entry.status === "certified");
  const candidates = catalog.exchanges.filter(
    (entry) => entry.status === "candidate" || entry.status === "discovered",
  );
  const others = catalog.exchanges.filter(
    (entry) => !["certified", "candidate", "discovered"].includes(entry.status),
  );
  return {
    certified,
    candidates,
    others,
    creatable: certified,
  };
}
