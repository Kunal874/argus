import assert from "node:assert/strict";
import test from "node:test";
import { analyzeUploads, parseCsvFile, type AnalysisDatasets, type ParsedDataset } from "../lib/client-analysis";
import { compactDecisionPackage } from "../lib/reasoning";
import { compactAnalysisSnapshot } from "../lib/snapshot";

const dataset = (rows: Record<string, string>[], headers = Object.keys(rows[0] ?? {})): ParsedDataset => ({ filename: "fixture.csv", headers, rows });

const viableData = (): AnalysisDatasets => ({
  sales: dataset(Array.from({ length: 42 }, (_, day) => ({ date: new Date(Date.UTC(2026, 5, day + 1)).toISOString().slice(0, 10), invoice_id: `I-${day}`, customer_id: "C-1", sku: "SKU-1", quantity: "5", selling_price: "150" }))),
  inventory: dataset([{ sku: "SKU-1", current_stock: "2", purchase_cost: "100", supplier_id: "S-1", package_size: "5", minimum_order_quantity: "10" }]),
  receivables: dataset([{ customer_id: "C-1", invoice_id: "R-1", due_date: "2026-05-01", invoice_amount: "10000", outstanding_amount: "8000" }]),
  suppliers: dataset([{ supplier_id: "S-1", sku: "SKU-1", average_lead_time_days: "12" }]),
});

test("CSV parser blocks empty, missing-column and duplicate-column files", async () => {
  await assert.rejects(() => parseCsvFile(new File(["date,invoice_id,customer_id,sku,quantity,selling_price\n"], "empty.csv"), "sales"), /no data rows/i);
  await assert.rejects(() => parseCsvFile(new File(["date,sku\n2026-01-01,A\n"], "missing.csv"), "sales"), /Missing columns/i);
  await assert.rejects(() => parseCsvFile(new File(["date,date,invoice_id,customer_id,sku,quantity,selling_price\n2026-01-01,2026-01-01,I,C,A,1,10\n"], "duplicate-columns.csv"), "sales"), /Duplicate columns/i);
});

test("validation quarantines invalid rows and blocks zero SKU coverage", () => {
  const data = viableData();
  data.sales.rows.push({ ...data.sales.rows[0], invoice_id: "NEG", quantity: "-10" });
  const quarantined = analyzeUploads(data, 50_000, 20_000);
  assert.equal(quarantined.quality.analysisReady, true);
  assert.equal(quarantined.quality.rejectedRows, 1);

  data.inventory.rows[0].sku = "UNRELATED";
  const disconnected = analyzeUploads(data, 50_000, 20_000);
  assert.equal(disconnected.quality.coverage, 0);
  assert.equal(disconnected.quality.analysisReady, false);
  assert.match(disconnected.quality.criticalErrors.join(" "), /cannot be connected to stock/i);
});

test("zero budget produces a cash-safe hold instead of a fabricated purchase", () => {
  const result = analyzeUploads(viableData(), 0, 20_000);
  assert.equal(result.quality.analysisReady, true);
  assert.equal(result.reorder.approvedUnits, 0);
  assert.equal(result.actions[0].amount, 0);
  assert.match(result.actions[0].title, /Hold/);
});

test("Gemini and report snapshots omit per-SKU model payloads but preserve verified summaries", () => {
  const demandModels = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`SKU-${index}`, { model: "seasonal_naive", forecast30: index }]));
  const raw = {
    quality: { analysisReady: true, coverage: 94, warnings: [] },
    summary: { availableCash: 120000, reserve: 70000, purchasingCapacity: 50000, overdueReceivables: 74000 },
    cash_runway: { status: "Safe", confidence: "Medium", shortageWeek: null, cashGap: 0 },
    anomaly_report: { reportDate: "2026-08-09", scannedRows: 90000, findings: [] },
    quant: { engine: "quant-v1", demandModels, demandAnomalies: demandModels, demandModelCoverage: 2000, reliableDemandModelCoverage: 1500, costIntelligence: { mode: "ml", observations: 1800, findings: [] } },
  };
  const reportSnapshot = compactAnalysisSnapshot(raw) as Record<string, unknown>;
  assert.equal("demandModels" in (reportSnapshot.quant as Record<string, unknown>), false);
  assert.ok(JSON.stringify(reportSnapshot).length < JSON.stringify(raw).length / 20);

  const compact = compactDecisionPackage({
    snapshot: raw,
    specialist_assessments: { inventory: "requires 20", cashflow: "funds 10", sales: "protect SKU-1", moderator: "partial order" },
    optimizer: { sku: "SKU-1", requiredUnits: 20, approvedUnits: 10 },
    verified_actions: [
      { type: "reorder", title: "Order 10", reason: "Verified", confidence: 90, amount: 1000 },
      { type: "collection", title: "Collect", reason: "Verified", confidence: 90, amount: 8000 },
      { type: "defer", title: "Pause", reason: "Verified", confidence: 90, amount: 500 },
    ],
  });
  assert.ok(JSON.stringify(compact).length < 10_000);
  assert.equal(JSON.stringify(compact).includes("seasonal_naive"), false);
});
