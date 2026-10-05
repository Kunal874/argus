import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";
import { buildBusinessReportPdf } from "../lib/business-report";
import { projectCashRunway } from "../lib/client-analysis";
import type { UploadAnalysis } from "../lib/client-analysis";
import { LANGUAGES, getLanguage } from "../lib/languages";

const analysis: UploadAnalysis = {
  quality: { analysisReady: true, validRows: 647, rejectedRows: 0, duplicates: 0, coverage: 100, matchedSkus: 4, missingLeadTimes: [], unknownSkus: [], warnings: [], criticalErrors: [] },
  summary: { availableCash: 120000, reserve: 70000, purchasingCapacity: 50000, overdueReceivables: 136000 },
  agents: { inventory: "requires 70 SWITCH-A", cashflow: "funds 60 now", sales: "protect SWITCH-A", moderator: "partial order plus collection" },
  reorder: { sku: "SWITCH-A", requiredUnits: 70, approvedUnits: 60, unitCost: 800, leadTime: 10, packageSize: 10, moq: 20, forecastDaily: 8, availableStock: 38 },
  cashRunway: projectCashRunway({ asOfDate: "2026-08-08", availableCash: 120000, reserve: 70000, proposedPurchase: 48000, obligationsProvided: true, receivables: [{ label: "Sharma", amount: 74000, expectedDate: "2026-08-15", probability: .55 }], obligations: [{ label: "Salaries", amount: 16000, date: "2026-08-14" }] }),
  anomalies: { reportDate: "2026-08-08", scannedRows: 647, findings: [{ id: "trend-CABLE-B", detectionSource: "deterministic", detector: "14-day versus 28-day demand trend rule", category: "sales", severity: "Medium", title: "Cable demand declined unusually", summary: "Recent demand is 22% below baseline.", actual: "2.4 units/day", expected: "3.0 units/day", whyFlagged: "The recent rate crossed the deterministic decline threshold.", evidence: ["SKU: CABLE-B", "55 days of stock cover"], recommendedCheck: "Check customers, stock availability and seasonality before pausing purchases.", confidence: 90 }] },
  actions: [
    { id: "r", type: "reorder", title: "Order 60 units of Switch A", subtitle: "5 days of stock", urgency: "Critical", confidence: 90, amount: 48000, impact: "Protects forecast sales", reason: "The budget funds 60 of 70 units while preserving the reserve.", evidence: ["Usable stock: 38", "Lead time: 10 days"] },
    { id: "c", type: "collection", title: "Confirm Sharma payment date", subtitle: "Overdue", urgency: "High", confidence: 92, amount: 74000, impact: "Expands purchasing capacity", reason: "This strategic receivable is overdue.", evidence: ["Outstanding: INR 74,000", "13 days overdue"] },
    { id: "d", type: "defer", title: "Pause Cable B purchase", subtitle: "55 days cover", urgency: "Medium", confidence: 88, amount: 7743, impact: "Retains cash", reason: "Demand is below baseline and stock cover is high.", evidence: ["Demand down 22%", "55 days cover"] },
  ],
};

test("generates a readable multi-page owner business report", async () => {
  const bytes = await buildBusinessReportPdf({ businessName: "Mehra Electricals", analysis, weekly: { outcomes: 0, measuredValue: 0, stockoutRisksAddressed: 0, paymentsReceived: 0, purchasesAvoided: 0, approvals: 0, autonomousActions: 0 } });
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 5);
  assert.equal(document.getTitle(), "Mehra Electricals - Argus Business Report");
  assert.ok(bytes.length > 7000);
});

test("embeds the correct Indic font and exports every non-English report", async () => {
  for (const language of LANGUAGES.filter((item) => item.code !== "en")) {
    const definition = getLanguage(language.code);
    assert.ok(definition.fontFile);
    const fontBytes = new Uint8Array(await fs.readFile(path.join(process.cwd(), "public", "fonts", definition.fontFile!)));
    let bytes: Uint8Array;
    try {
      bytes = await buildBusinessReportPdf({
        businessName: "Mehra Electricals",
        analysis,
        weekly: { outcomes: 0, measuredValue: 0, stockoutRisksAddressed: 0, paymentsReceived: 0, purchasesAvoided: 0, approvals: 0, autonomousActions: 0 },
        languageCode: language.code,
        fontBytes,
      });
    } catch (error) {
      throw new Error(`${language.code}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const document = await PDFDocument.load(bytes);
    assert.equal(document.getPageCount(), 3, language.code);
    assert.ok(bytes.length > 10_000, language.code);
  }
});
