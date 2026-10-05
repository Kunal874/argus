import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCosts, detectDemandAnomaly, forecastDemand, type CostObservation } from "../lib/quant-engine";

test("demand forecasting backtests models and returns finite intervals", () => {
  const points = Array.from({ length: 70 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    quantity: [4, 5, 6, 7, 8, 12, 14][index % 7],
  }));
  const forecast = forecastDemand(points);
  assert.equal(forecast.model, "seasonal_naive");
  assert.equal(forecast.historyDays, 70);
  assert.ok(forecast.forecast30 > 0);
  assert.ok(forecast.lower14 <= forecast.forecast14);
  assert.ok(forecast.upper14 >= forecast.forecast14);
  assert.ok((forecast.wape ?? 1) < .01);
});

test("short demand history uses a transparent low-confidence baseline", () => {
  const forecast = forecastDemand([{ date: "2026-08-01", quantity: 5 }, { date: "2026-08-03", quantity: 7 }]);
  assert.equal(forecast.model, "moving_average");
  assert.equal(forecast.confidence, "Low");
  assert.equal(forecast.wape, null);
});

test("forecast residuals detect a planted demand spike without flagging the normal seasonal series", () => {
  const normal = Array.from({ length: 70 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    quantity: [4, 5, 6, 7, 8, 12, 14][index % 7],
  }));
  assert.equal(detectDemandAnomaly(normal).status, "normal");
  const spiked = normal.map((point, index) => index === normal.length - 1 ? { ...point, quantity: 80 } : point);
  const finding = detectDemandAnomaly(spiked);
  assert.equal(finding.status, "detected");
  assert.equal(finding.model, "seasonal_naive");
  assert.ok(finding.actual > finding.upper);
  assert.ok((finding.residualScore ?? 0) > 3);
});

test("demand anomaly model abstains when history is insufficient", () => {
  const finding = detectDemandAnomaly(Array.from({ length: 20 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), quantity: index % 3,
  })));
  assert.equal(finding.status, "abstained");
  assert.match(finding.reason, /35 observed sales days/);
});

test("cost ensemble detects a planted supplier-price and margin anomaly", () => {
  const observations: CostObservation[] = Array.from({ length: 60 }, (_, index) => {
    const currentCost = 100 + index * 7;
    return {
      sku: `SKU-${index}`,
      productName: `Product ${index}`,
      category: index % 2 ? "Lighting" : "Cables",
      supplierId: `SUP-${index}`,
      supplierName: `Supplier ${index}`,
      currentCost,
      quotedCost: currentCost * (1.01 + (index % 5) * .004),
      sellingPrice: currentCost * 1.45,
      forecast30: 40,
      leadTime: 7 + index % 8,
      moq: 10 + index % 4 * 5,
      packageSize: 5,
      qualityRating: 4,
      onTimeRate: .9,
    };
  });
  observations.push({ ...observations[20], supplierId: "SUP-RISK", supplierName: "Risk Supplier", quotedCost: observations[20].currentCost * 1.35, forecast30: 80 });
  const report = analyzeCosts(observations, 100);
  assert.equal(report.mode, "ml");
  assert.ok(report.holdoutMape !== null && report.holdoutMape < .15);
  assert.equal(report.findings[0]?.supplierId, "SUP-RISK");
  assert.ok(report.findings[0].marginAtRisk30 > 5_000);
});

test("small cost datasets use the declared fallback instead of pretending ML accuracy", () => {
  const report = analyzeCosts([{
    sku: "A", productName: "Cable", category: "Cables", supplierId: "S1", supplierName: "Supplier",
    currentCost: 100, quotedCost: 125, sellingPrice: 150, forecast30: 100, leadTime: 7, moq: 10,
    packageSize: 5, qualityRating: 4, onTimeRate: .9,
  }], 100);
  assert.equal(report.mode, "fallback");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].confidence, 58);
});
