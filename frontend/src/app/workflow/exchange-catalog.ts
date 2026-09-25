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
      let productName = kind;
      if (kind === "swap") {
        productName = "Swap";
      } else if (kind === "future") {
        productName = "Future";
      }
      let settlementName = "Abwicklung ungeklärt";
      if (settlement === "linear") {
        settlementName = "linear";
      } else if (settlement === "inverse") {
        settlementName = "invers";
      }
      return `${productName} (${settlementName})`;
    }).join(" · ")}`
    : "Keine Derivate laut gepinnter CCXT-Inventur";
  let decision = "Für TSX Core derzeit nicht freigabereif";
  if (entry.id === "hyperliquid" && entry.assessment.decision === "existing") {
    decision = "TSX lokal nur first-DEX/USDC/linear/Perp mit Master-Key offline geprüft; Provider-, Konto- und Release-Nachweise offen";
  } else if (entry.assessment.decision === "existing") {
    decision = "Bestehendes Profil; Produkt- und Provider-Scope gesondert nachweisen";
  } else if (entry.assessment.decision === "not_derivative") {
    decision = "Keine Futures-Eignung";
  }
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
