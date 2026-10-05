import type { AnalysisAction, UploadAnalysis } from "./client-analysis";

export type PrimaryView = "home" | "actions" | "money" | "reports" | "more";
export type BusinessHealth = "doing-well" | "needs-attention" | "act-today";
export type ActionDisplayState = "action-required" | "review" | "no-action";
export type AttentionItem = {
  id: string;
  label: string;
  detail: string;
  severity: "critical" | "attention";
  target: "action" | "unusual-activity";
  action?: AnalysisAction;
};
export type BusinessAreaStatus = {
  id: "stock-sales" | "customer-payments" | "supplier-prices";
  label: string;
  status: string;
  detail: string;
  tone: "good" | "attention" | "critical";
  target: PrimaryView;
  action?: AnalysisAction;
};

export function getActionDisplayState(action: AnalysisAction): ActionDisplayState {
  if (action.amount <= 0) return "no-action";
  return action.urgency === "Critical" || action.urgency === "High" ? "action-required" : "review";
}

export function deriveBusinessHealth(analysis: UploadAnalysis): BusinessHealth {
  const actionable = analysis.actions.filter((action) => action.amount > 0);
  if (analysis.cashRunway.status === "At risk" || actionable.some((action) => action.urgency === "Critical")) return "act-today";
  const importantFinding = analysis.anomalies.findings.some((finding) => finding.severity === "Critical" || finding.severity === "High");
  if (analysis.cashRunway.status === "Watch" || actionable.some((action) => action.urgency === "High") || importantFinding) return "needs-attention";
  return "doing-well";
}

export function businessHealthCopy(health: BusinessHealth) {
  if (health === "act-today") return {
    eyebrow: "ACT TODAY",
    title: "Your business needs action today.",
    detail: "Start with the first recommendation to protect cash or near-term sales.",
  };
  if (health === "needs-attention") return {
    eyebrow: "NEEDS ATTENTION",
    title: "A few things need your attention.",
    detail: "Your position is manageable, but acting on the priority items will reduce risk.",
  };
  return {
    eyebrow: "DOING WELL",
    title: "Your business is in a stable position.",
    detail: "No critical issue is visible in the latest business check.",
  };
}

export function deriveAttentionItems(analysis: UploadAnalysis): AttentionItem[] {
  const actionItems = analysis.actions
    .filter((action) => action.amount > 0 && (action.urgency === "Critical" || action.urgency === "High"))
    .map<AttentionItem>((action) => ({
      id: action.id,
      label: action.title,
      detail: action.impact,
      severity: action.urgency === "Critical" ? "critical" : "attention",
      target: "action",
      action,
    }));
  const findingItems = analysis.anomalies.findings
    .filter((finding) => finding.severity === "Critical" || finding.severity === "High")
    .filter((finding) => !actionItems.some((item) => item.label.toLowerCase().includes(finding.title.toLowerCase())))
    .slice(0, 2)
    .map<AttentionItem>((finding) => ({
      id: finding.id,
      label: finding.title,
      detail: finding.recommendedCheck,
      severity: finding.severity === "Critical" ? "critical" : "attention",
      target: "unusual-activity",
    }));
  return [...actionItems, ...findingItems];
}

export function deriveBusinessAreas(analysis: UploadAnalysis): BusinessAreaStatus[] {
  const stockAction = analysis.actions.find((action) => action.type === "reorder" || action.type === "defer");
  const collectionAction = analysis.actions.find((action) => action.type === "collection");
  const costAction = analysis.actions.find((action) => action.type === "cost_control");
  const costFinding = analysis.quant.costIntelligence.findings[0];
  return [
    {
      id: "stock-sales",
      label: "Stock & sales",
      status: stockAction && stockAction.amount > 0 ? "Review today" : "No urgent action",
      detail: stockAction?.subtitle ?? "No stock decision is available.",
      tone: stockAction?.urgency === "Critical" && stockAction.amount > 0 ? "critical" : stockAction && stockAction.amount > 0 ? "attention" : "good",
      target: "actions",
      action: stockAction,
    },
    {
      id: "customer-payments",
      label: "Customer payments",
      status: collectionAction && collectionAction.amount > 0 ? "Follow-up recommended" : "No follow-up needed",
      detail: collectionAction?.subtitle ?? "No payment decision is available.",
      tone: collectionAction && collectionAction.amount > 0 ? "attention" : "good",
      target: "money",
      action: collectionAction,
    },
    {
      id: "supplier-prices",
      label: "Supplier prices",
      status: costAction?.amount ? "Price needs checking" : costFinding ? "Review the latest price" : "No material pressure",
      detail: costAction?.subtitle ?? (costFinding ? `${costFinding.productName} has the highest current price risk.` : "Costs are inside the current expected ranges."),
      tone: costAction?.amount ? "attention" : "good",
      target: "money",
      action: costAction,
    },
  ];
}
