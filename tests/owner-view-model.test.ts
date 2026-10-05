import assert from "node:assert/strict";
import test from "node:test";
import { businessHealthCopy, deriveBusinessAreas, deriveBusinessHealth, getActionDisplayState } from "../lib/owner-view-model";
import type { UploadAnalysis } from "../lib/client-analysis";

const base = {
  actions: [
    { id: "r", type: "reorder", title: "Order stock", subtitle: "Low stock", urgency: "Medium", confidence: 80, amount: 1000, impact: "Protect sales", reason: "Stock is low", evidence: [] },
    { id: "c", type: "collection", title: "No collection", subtitle: "Nothing due", urgency: "Medium", confidence: 90, amount: 0, impact: "No action", reason: "Nothing due", evidence: [] },
    { id: "d", type: "defer", title: "No pause", subtitle: "Stock is normal", urgency: "Medium", confidence: 80, amount: 0, impact: "No action", reason: "Stock is normal", evidence: [] },
  ],
  cashRunway: { status: "Safe" },
  anomalies: { findings: [] },
  quant: { costIntelligence: { findings: [] } },
} as unknown as UploadAnalysis;

test("owner health follows existing action urgency and cash status", () => {
  assert.equal(deriveBusinessHealth(base), "doing-well");
  assert.equal(deriveBusinessHealth({ ...base, cashRunway: { ...base.cashRunway, status: "Watch" } }), "needs-attention");
  assert.equal(deriveBusinessHealth({ ...base, actions: base.actions.map((action, index) => index ? action : { ...action, urgency: "Critical" }) }), "act-today");
  assert.equal(deriveBusinessHealth({ ...base, cashRunway: { ...base.cashRunway, status: "At risk" } }), "act-today");
  assert.match(businessHealthCopy("needs-attention").title, /attention/i);
});

test("zero-value decisions remain visible but are not presented as alerts", () => {
  assert.equal(getActionDisplayState(base.actions[0]), "review");
  assert.equal(getActionDisplayState(base.actions[1]), "no-action");
  const areas = deriveBusinessAreas(base);
  assert.equal(areas.length, 3);
  assert.equal(areas.find((area) => area.id === "customer-payments")?.tone, "good");
});
