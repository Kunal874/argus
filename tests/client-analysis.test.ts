import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUploads, normalizeSku, parseBusinessDate, parseNumeric, projectCashRunway, simulateReorder, type AnalysisDatasets, type ParsedDataset } from "../lib/client-analysis";

const dataset = (rows: Record<string, string>[]): ParsedDataset => ({ filename: "fixture.csv", headers: Object.keys(rows[0] ?? {}), rows });

function scenario() {
  const sales: Record<string, string>[] = [];
  const start = Date.UTC(2026, 5, 1);
  for (let day = 0; day < 42; day += 1) {
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    sales.push({ date, invoice_id: `INV-${day}-A`, customer_id: "C1", sku: day % 2 ? "switch a" : "SWITCH/A", quantity: String(day < 28 ? 3 : 9), selling_price: "₹1,250" });
    sales.push({ date, invoice_id: `INV-${day}-B`, customer_id: "C2", sku: "CABLE-B", quantity: String(day < 28 ? 5 : 1), selling_price: "450" });
  }
  sales.push({ ...sales[0] });
  const data: AnalysisDatasets = {
    sales: dataset(sales),
    inventory: dataset([
      { sku: "SWITCH-A", product_name: "Switch", current_stock: "20", reserved_stock: "2", incoming_stock: "0", purchase_cost: "800", supplier_id: "S1", minimum_order_quantity: "20", package_size: "10" },
      { sku: "CABLE-B", product_name: "Cable", current_stock: "220", reserved_stock: "0", incoming_stock: "0", purchase_cost: "296", supplier_id: "S2", minimum_order_quantity: "25", package_size: "5" },
    ]),
    receivables: dataset([{ customer_id: "C1", customer_name: "Sharma Electricals", invoice_id: "OLD-1", due_date: "15/06/2026", invoice_amount: "₹74,000", outstanding_amount: "74000", relationship_type: "Strategic", strategic_flag: "TRUE", dispute_flag: "false" }]),
    suppliers: dataset([
      { supplier_id: "S1", sku: "switch_a", average_lead_time_days: "10" },
      { supplier_id: "S2", sku: "CABLE-B", average_lead_time_days: "7" },
    ]),
  };
  return data;
}

test("normalizes common Indian export formats", () => {
  assert.equal(normalizeSku(" switch/A "), "SWITCH-A");
  assert.equal(parseNumeric("₹1,25,000"), 125000);
  assert.equal(parseBusinessDate("15/06/2026")?.toISOString().slice(0, 10), "2026-06-15");
});

test("calculates three data-driven actions and isolates duplicates", () => {
  const result = analyzeUploads(scenario(), 50_000, 70_000);
  assert.equal(result.quality.analysisReady, true);
  assert.equal(result.quality.duplicates, 1);
  assert.equal(result.quality.coverage, 100);
  assert.deepEqual(result.actions.map((action) => action.type), ["reorder", "collection", "defer"]);
  assert.equal(result.actions[1].meta?.strategic, true);
  assert.match(result.actions[2].title, /Pause/);
  assert.equal(result.reorder.approvedUnits % result.reorder.packageSize, 0);
  assert.ok(result.reorder.approvedUnits <= result.reorder.requiredUnits);
  assert.ok(result.reorder.approvedUnits < result.reorder.requiredUnits, "cashflow should constrain the inventory requirement");
  assert.ok(result.anomalies.findings.some((finding) => finding.category === "sales"));
  assert.ok(result.anomalies.findings.some((finding) => finding.id === "data-duplicates"));
});

test("builds an explainable anomaly report across operational categories", () => {
  const data = scenario();
  data.inventory.rows[0].purchase_cost = "1000";
  data.inventory.rows[1].reserved_stock = "300";
  data.suppliers.rows[0].last_purchase_price = "800";
  data.sales.rows.filter((row) => row.sku === "CABLE-B").forEach((row) => { row.return_quantity = "1"; });
  const result = analyzeUploads(data, 50_000, 70_000);
  const categories = new Set(result.anomalies.findings.map((finding) => finding.category));
  assert.ok(categories.has("pricing"));
  assert.ok(categories.has("returns"));
  assert.ok(categories.has("inventory"));
  for (const finding of result.anomalies.findings) {
    assert.ok(finding.detectionSource === "ml" || finding.detectionSource === "deterministic");
    assert.ok(finding.detector.length > 5);
    assert.ok(finding.whyFlagged.length > 20);
    assert.ok(finding.evidence.length >= 2);
    assert.ok(finding.recommendedCheck.length > 20);
  }
});

test("what-if constraints change the order deterministically", () => {
  const base = { availableCash: 160_000, budget: 90_000, reserve: 70_000, requiredUnits: 100, unitCost: 800, packageSize: 10, moq: 20, leadTime: 10, baseLeadTime: 10, demandMultiplier: 1 };
  const constrained = simulateReorder(base);
  const moreBudget = simulateReorder({ ...base, availableCash: 240_000, budget: 160_000 });
  const delayed = simulateReorder({ ...base, leadTime: 20 });
  const higherReserve = simulateReorder({ ...base, reserve: 120_000 });
  assert.equal(constrained.approvedUnits, 100);
  assert.ok(moreBudget.approvedUnits >= constrained.approvedUnits);
  assert.ok(delayed.requiredUnits > constrained.requiredUnits);
  assert.ok(higherReserve.approvedUnits < constrained.approvedUnits);
});

test("projects a conservative 13-week runway and exposes the first reserve breach", () => {
  const runway = projectCashRunway({
    asOfDate: "2026-08-08", availableCash: 120_000, reserve: 70_000, proposedPurchase: 40_000, obligationsProvided: true,
    receivables: [{ label: "Customer payment", amount: 50_000, expectedDate: "2026-08-15", probability: .75 }],
    obligations: [{ label: "Salaries and rent", amount: 45_000, date: "2026-08-12" }],
  });
  assert.equal(runway.weeks.length, 13);
  assert.equal(runway.shortageWeek, 1);
  assert.equal(runway.status, "At risk");
  assert.equal(runway.cashGap, 35_000);
  assert.ok(runway.minimumConservativeBalance < 70_000);
});

test("delayed customer payments worsen the cash runway without changing source data", () => {
  const input = {
    asOfDate: "2026-08-08", availableCash: 100_000, reserve: 70_000, proposedPurchase: 0, obligationsProvided: true,
    receivables: [{ label: "Expected collection", amount: 80_000, expectedDate: "2026-08-12", probability: .75 }],
    obligations: [{ label: "Supplier payment", amount: 60_000, date: "2026-08-20" }],
  };
  const onTime = projectCashRunway(input);
  const delayed = projectCashRunway({ ...input, paymentDelayDays: 21 });
  assert.equal(onTime.shortageWeek, null);
  assert.equal(delayed.shortageWeek, 2);
  assert.ok(delayed.minimumConservativeBalance < onTime.minimumConservativeBalance);
  assert.equal(input.receivables[0].expectedDate, "2026-08-12");
});

test("cash obligations reduce immediate purchasing capacity", () => {
  const data = scenario();
  data.cashObligations = dataset([{ date: "2026-07-13", label: "GST payment", amount: "45000" }]);
  const result = analyzeUploads(data, 50_000, 70_000);
  assert.equal(result.cashRunway.inputs.obligations.length, 1);
  assert.ok(result.summary.purchasingCapacity < 50_000);
  assert.ok(result.actions[0].reason.includes("four-week conservative cash outlook"));
});

test("critical unusable inventory blocks analysis", () => {
  const data = scenario();
  data.inventory.rows.forEach((row) => { row.purchase_cost = ""; });
  const result = analyzeUploads(data, 90_000, 70_000);
  assert.equal(result.quality.analysisReady, false);
  assert.ok(result.quality.criticalErrors.length > 0);
});
