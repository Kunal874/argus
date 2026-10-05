type VerifiedAction = {
  type?: string;
  title?: string;
  reason?: string;
  impact?: string;
  confidence?: number;
  amount?: number;
};

export type DecisionPackage = {
  snapshot?: unknown;
  specialist_assessments?: unknown;
  verified_actions?: VerifiedAction[];
  optimizer?: unknown;
};

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const pick = (source: unknown, keys: string[]) => {
  const record = objectValue(source);
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
};

const allowedActionTypes = new Set(["reorder", "collection", "defer", "cost_control"]);
const promptInjectionPatterns = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?/i,
  /(?:reveal|repeat|print|show)\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|message|instructions?)/i,
  /(?:reveal|print|show|extract)\s+(?:an?\s+)?(?:api\s*key|secret|credential|token)/i,
  /(?:bypass|disable|override)\s+(?:the\s+)?(?:guardrails?|safety|verification|policy)/i,
  /(?:you\s+are\s+now|act\s+as)\s+(?:an?\s+)?(?:system|developer|administrator|unrestricted)/i,
  /<(?:script|iframe|object|embed)\b/i,
];

const isBoundedText = (value: unknown, maxLength: number) => typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
const isSafeAmount = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER;
const isSafeConfidence = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;

export function isValidDecisionPackage(value: unknown): value is DecisionPackage {
  if (!value || typeof value !== "object") return false;
  const actions = (value as DecisionPackage).verified_actions;
  if (!Array.isArray(actions) || actions.length !== 3) return false;
  if (!actions.every((action) => action && isBoundedText(action.type, 40) && allowedActionTypes.has(action.type as string) &&
    isBoundedText(action.title, 240) && isBoundedText(action.reason, 2_000) &&
    (action.impact === undefined || isBoundedText(action.impact, 1_000)) &&
    isSafeAmount(action.amount) && isSafeConfidence(action.confidence))) return false;
  const types = actions.map((action) => action.type);
  return new Set(types).size === 3 && types.includes("reorder") && types.includes("collection") &&
    (types.includes("defer") || types.includes("cost_control"));
}

export function deterministicExplanation(decisionPackage: DecisionPackage) {
  const actions = decisionPackage.verified_actions ?? [];
  const purchase = actions.find((action) => action.type === "reorder");
  const collection = actions.find((action) => action.type === "collection");
  const pause = actions.find((action) => action.type === "defer");
  const costReview = actions.find((action) => action.type === "cost_control");
  const sentences = [
    purchase ? `${purchase.title}. ${purchase.reason}` : null,
    collection ? `${collection.title}; the owner must choose the relationship-sensitive follow-up.` : null,
    costReview ? `${costReview.title}. ${costReview.reason}` : pause ? `${pause.title} to preserve cash for higher-priority needs.` : null,
    "All figures come from verified calculations, and no supplier or customer action is sent without approval.",
  ].filter(Boolean);
  return sentences.join(" ");
}

export function deterministicGuardrailExplanation() {
  return "Argus verified three cash-safe actions from the uploaded business data. Review the reorder, collection and final working-capital recommendation against the evidence shown in the dashboard. The owner must approve every external action before it is sent or recorded.";
}

const numericTokens = (text: string) => text.match(/(?<![A-Za-z])\d[\d,]*(?:\.\d+)?%?/g)?.map((token) => token.replaceAll(",", "").replace("%", "")) ?? [];

export function hasOnlySupportedNumbers(explanation: string, decisionPackage: DecisionPackage) {
  const allowed = new Set(numericTokens(JSON.stringify(decisionPackage)));
  return numericTokens(explanation).every((token) => allowed.has(token));
}

export function hasPromptInjectionRisk(value: unknown) {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length && inspected < 2_000) {
    const current = pending.pop();
    inspected += 1;
    if (typeof current === "string" && promptInjectionPatterns.some((pattern) => pattern.test(current))) return true;
    if (Array.isArray(current)) pending.push(...current);
    else if (current && typeof current === "object") pending.push(...Object.values(current as Record<string, unknown>));
  }
  return pending.length > 0;
}

export function isSafeProviderExplanation(explanation: string) {
  const normalized = explanation.trim();
  if (normalized.length < 80 || normalized.length > 1_200) return false;
  if (normalized.includes("```") || /https?:\/\//i.test(normalized) || hasPromptInjectionRisk(normalized)) return false;
  const sentences = normalized.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  if (sentences.length !== 3) return false;
  return /\b(?:owner|human)\b[^.!?]{0,100}\b(?:approve|approval|review|confirm|authori[sz]e)\b/i.test(normalized) ||
    /\b(?:approve|approval|review|confirm|authori[sz]e)\b[^.!?]{0,100}\b(?:owner|human)\b/i.test(normalized);
}

export function compactDecisionPackage(value: DecisionPackage): DecisionPackage {
  const snapshot = objectValue(value.snapshot);
  const anomalyReport = objectValue(snapshot.anomaly_report);
  const quant = objectValue(snapshot.quant);
  const costIntelligence = objectValue(quant.costIntelligence);
  return {
    snapshot: {
      quality: pick(snapshot.quality, ["analysisReady", "coverage", "rejectedRows", "duplicates", "warnings", "criticalErrors"]),
      summary: pick(snapshot.summary, ["availableCash", "reserve", "purchasingCapacity", "overdueReceivables"]),
      cash_runway: pick(snapshot.cash_runway, ["status", "confidence", "minimumConservativeBalance", "shortageWeek", "cashGap", "totalExpectedInflows", "totalCommittedOutflows", "assumptions"]),
      anomaly_report: {
        ...pick(anomalyReport, ["reportDate", "scannedRows"]),
        findings: Array.isArray(anomalyReport.findings) ? anomalyReport.findings.slice(0, 5).map((finding) => pick(finding, ["id", "detectionSource", "detector", "category", "severity", "title", "summary", "confidence"])) : [],
      },
      quant: {
        ...pick(quant, ["engine", "demandModelCoverage", "reliableDemandModelCoverage", "averageDemandWape", "medianDemandWape"]),
        costIntelligence: {
          ...pick(costIntelligence, ["mode", "model", "observations", "holdoutMape", "assumptions"]),
          findings: Array.isArray(costIntelligence.findings) ? costIntelligence.findings.slice(0, 3).map((finding) => pick(finding, ["id", "sku", "supplierName", "actualCost", "expectedLower", "expectedUpper", "marginAtRisk30", "confidence"])) : [],
        },
      },
    },
    specialist_assessments: pick(value.specialist_assessments, ["inventory", "cashflow", "sales", "moderator"]),
    verified_actions: value.verified_actions?.map(({ type, title, reason, impact, confidence, amount }) => ({ type, title, reason, impact, confidence, amount })),
    optimizer: pick(value.optimizer, ["sku", "requiredUnits", "approvedUnits", "unitCost", "leadTime", "packageSize", "moq", "forecastDaily", "availableStock"]),
  };
}
