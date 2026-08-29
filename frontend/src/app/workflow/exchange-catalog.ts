import type { ExchangeCatalog } from "./types";

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
