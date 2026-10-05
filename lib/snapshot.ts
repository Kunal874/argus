export function compactAnalysisSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const source = snapshot as Record<string, unknown>;
  const quant = source.quant && typeof source.quant === "object" ? source.quant as Record<string, unknown> : undefined;
  if (!quant) return snapshot;
  const reportQuant = { ...quant };
  delete reportQuant.demandModels;
  delete reportQuant.demandAnomalies;
  return { ...source, quant: reportQuant };
}
