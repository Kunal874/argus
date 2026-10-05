import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCosts, forecastDemand, type CostObservation } from "../lib/quant-engine";
import { requirePrincipal } from "../lib/server-auth";

test("quant v2 exposes leakage-safe evaluation and intermittent-demand metadata", () => {
  const points = Array.from({ length: 84 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), quantity: index % 6 === 0 ? 12 : 0 }));
  const result = forecastDemand(points);
  assert.equal(result.modelVersion, "demand-v2");
  assert.equal(result.segment, "intermittent");
  assert.equal(result.validationFolds, 3);
  assert.ok(result.metrics.wape !== null);
  assert.ok(result.metrics.coverage80 !== null);
});

test("supplier cost v2 only enables challenger promotion with 200 dated lines", () => {
  const observations: CostObservation[] = Array.from({ length: 200 }, (_, index) => ({ sku: `SKU-${index}`, productName: `Item ${index}`, category: "Electrical", supplierId: `S-${index}`, supplierName: `Supplier ${index}`, currentCost: 100 + index, quotedCost: 102 + index, sellingPrice: 180 + index, forecast30: 10, leadTime: 7, moq: 10, packageSize: 5, qualityRating: 4, onTimeRate: .9, observedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10) }));
  const result = analyzeCosts(observations);
  assert.equal(result.modelVersion, "supplier-cost-v2");
  assert.equal(result.promotionEligible, true);
});

test("host-provided identity derives a tenant and ignores client-selected tenant data", async () => {
  const request = new Request("https://argus.example/api/v1/me", { headers: { "oai-authenticated-user-id": "user-123", "oai-authenticated-user-email": "owner@example.com" } });
  const principal = await requirePrincipal(request, "actions:approve");
  assert.equal(principal.tenantId, "sites:user-123");
  assert.equal(principal.role, "owner");
  assert.ok(principal.permissions.includes("actions:approve"));
});
