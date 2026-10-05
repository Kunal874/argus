import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import * as fontkit from "fontkit";
import type { UploadAnalysis } from "./client-analysis";
import { normalizeLanguageCode, type LanguageCode } from "./languages";
import { buildDeterministicLocalizedReport, validateLocalizedReport, type LocalizedDecisionReport } from "./multilingual-report";
import type { DecisionPackage } from "./reasoning";
import { buildComplexScriptBusinessReportPdf } from "./complex-script-report";

export type WeeklyReportSummary = {
  outcomes: number;
  measuredValue: number;
  stockoutRisksAddressed: number;
  paymentsReceived: number;
  purchasesAvoided: number;
  approvals: number;
  autonomousActions: number;
};

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 46;
const contentWidth = pageWidth - margin * 2;
const ink = rgb(0.055, 0.11, 0.095);
const forest = rgb(0.04, 0.26, 0.21);
const green = rgb(0.67, 0.82, 0.41);
const soft = rgb(0.96, 0.97, 0.94);
const line = rgb(0.84, 0.86, 0.83);
const muted = rgb(0.34, 0.4, 0.37);
const amber = rgb(0.67, 0.39, 0.05);
const danger = rgb(0.67, 0.22, 0.12);

const clean = (value: unknown) => String(value ?? "")
  .replaceAll("₹", "INR ")
  .replace(/[–—]/g, "-")
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace("…", "...")
  .replace(/[^ -~]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const money = (value: number) => `INR ${Math.round(value).toLocaleString("en-IN")}`;

function wrapText(text: string, font: PDFFont, size: number, width: number) {
  const words = clean(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

class ReportWriter {
  readonly document: PDFDocument;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  page!: PDFPage;
  y = 0;

  constructor(document: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.document = document;
    this.regular = regular;
    this.bold = bold;
    this.newPage();
  }

  newPage() {
    this.page = this.document.addPage([pageWidth, pageHeight]);
    this.y = pageHeight - margin;
  }

  ensure(height: number) {
    if (this.y - height < 62) this.newPage();
  }

  text(value: string, x: number, y: number, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(clean(value), { x, y, size: options.size ?? 10, font: options.bold ? this.bold : this.regular, color: options.color ?? ink });
  }

  paragraph(value: string, options: { x?: number; width?: number; size?: number; lineHeight?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gapAfter?: number } = {}) {
    const x = options.x ?? margin;
    const width = options.width ?? contentWidth;
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? size * 1.42;
    const font = options.bold ? this.bold : this.regular;
    const lines = wrapText(value, font, size, width);
    this.ensure(lines.length * lineHeight + (options.gapAfter ?? 0));
    for (const lineText of lines) {
      this.text(lineText, x, this.y, { size, bold: options.bold, color: options.color });
      this.y -= lineHeight;
    }
    this.y -= options.gapAfter ?? 0;
  }

  section(title: string, subtitle?: string) {
    this.ensure(subtitle ? 52 : 34);
    this.y -= 8;
    this.text(title.toUpperCase(), margin, this.y, { size: 9, bold: true, color: forest });
    this.y -= 14;
    if (subtitle) this.paragraph(subtitle, { size: 9, color: muted, gapAfter: 8 });
    this.page.drawLine({ start: { x: margin, y: this.y }, end: { x: pageWidth - margin, y: this.y }, thickness: 0.8, color: line });
    this.y -= 16;
  }

  heading(title: string) {
    this.ensure(38);
    this.paragraph(title, { size: 19, lineHeight: 22, bold: true, gapAfter: 10 });
  }

  label(value: string, x: number, y: number, color = muted) {
    this.text(value.toUpperCase(), x, y, { size: 7.5, bold: true, color });
  }
}

function drawReportHeader(writer: ReportWriter, businessName: string, reportDate: string) {
  writer.page.drawRectangle({ x: margin, y: writer.y - 25, width: 27, height: 27, color: forest });
  writer.text("A", margin + 8.5, writer.y - 17, { size: 14, bold: true, color: green });
  writer.text("ARGUS", margin + 38, writer.y - 8, { size: 12, bold: true, color: ink });
  writer.text("WORKING CAPITAL COPILOT", margin + 38, writer.y - 21, { size: 6.8, color: muted });
  writer.text(clean(businessName), pageWidth - margin - writer.bold.widthOfTextAtSize(clean(businessName), 9), writer.y - 8, { size: 9, bold: true });
  writer.text(`REPORT DATE ${reportDate}`, pageWidth - margin - writer.regular.widthOfTextAtSize(`REPORT DATE ${reportDate}`, 7), writer.y - 21, { size: 7, color: muted });
  writer.y -= 54;
}

function drawMetric(writer: ReportWriter, x: number, y: number, width: number, label: string, value: string, color = ink) {
  writer.page.drawRectangle({ x, y, width, height: 53, color: soft, borderColor: line, borderWidth: .5 });
  writer.label(label, x + 11, y + 36);
  const lines = wrapText(value, writer.bold, 14, width - 22).slice(0, 2);
  lines.forEach((lineText, index) => writer.text(lineText, x + 11, y + 17 - index * 14, { size: index ? 9 : 14, bold: true, color }));
}

function drawPriority(writer: ReportWriter, action: UploadAnalysis["actions"][number], index: number) {
  const titleLines = wrapText(action.title, writer.bold, 12, contentWidth - 85);
  const reasonLines = wrapText(action.reason, writer.regular, 8.5, contentWidth - 85).slice(0, 3);
  const height = 48 + titleLines.length * 14 + reasonLines.length * 11;
  writer.ensure(height + 8);
  const top = writer.y;
  writer.page.drawRectangle({ x: margin, y: top - height, width: contentWidth, height, color: rgb(1, 1, 1), borderColor: line, borderWidth: .7 });
  writer.page.drawCircle({ x: margin + 21, y: top - 25, size: 12, color: action.urgency === "Critical" ? danger : action.urgency === "High" ? amber : forest });
  writer.text(String(index + 1), margin + 18, top - 28, { size: 9, bold: true, color: rgb(1, 1, 1) });
  writer.label(`${action.type} / ${action.urgency}`, margin + 45, top - 17, action.urgency === "Critical" ? danger : forest);
  titleLines.forEach((lineText, lineIndex) => writer.text(lineText, margin + 45, top - 35 - lineIndex * 14, { size: 12, bold: true }));
  let reasonY = top - 35 - titleLines.length * 14 - 3;
  reasonLines.forEach((lineText) => { writer.text(lineText, margin + 45, reasonY, { size: 8.5, color: muted }); reasonY -= 11; });
  writer.text(clean(action.impact), margin + 45, top - height + 13, { size: 8.3, bold: true, color: forest });
  writer.y -= height + 9;
}

export async function buildBusinessReportPdf(input: { businessName: string; analysis: UploadAnalysis; weekly: WeeklyReportSummary; languageCode?: LanguageCode; localizedReport?: LocalizedDecisionReport | null; fontBytes?: Uint8Array }) {
  const languageCode = normalizeLanguageCode(input.languageCode);
  if (languageCode !== "en" && input.fontBytes?.length) return buildComplexScriptBusinessReportPdf({ ...input, languageCode });
  if (languageCode !== "en") return buildLocalizedBusinessReportPdf({ ...input, languageCode });
  const document = await PDFDocument.create();
  document.setTitle(`${input.businessName} - Argus Business Report`);
  document.setAuthor("Argus Working Capital Copilot");
  document.setSubject("Verified weekly working-capital decision report");
  document.setKeywords(["working capital", "inventory", "receivables", "MSME", "Argus"]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const writer = new ReportWriter(document, regular, bold);
  const { analysis, weekly } = input;
  const reportDate = analysis.anomalies.reportDate;
  const highRisk = analysis.cashRunway.status === "At risk" || analysis.actions.some((action) => action.urgency === "Critical") || analysis.anomalies.findings.some((finding) => finding.severity === "Critical" || finding.severity === "High");

  drawReportHeader(writer, input.businessName, reportDate);
  writer.label("OWNER BRIEF - READ THIS PAGE FIRST", margin, writer.y, forest);
  writer.y -= 26;
  writer.paragraph("Your business needs attention in three places.", { size: 25, lineHeight: 29, bold: true, width: 470, gapAfter: 8 });
  writer.paragraph("This page is designed to be understood in under one minute. Detailed calculations and evidence follow.", { size: 10, color: muted, gapAfter: 17 });
  writer.page.drawRectangle({ x: margin, y: writer.y - 39, width: contentWidth, height: 39, color: highRisk ? rgb(1, .95, .91) : rgb(.93, .97, .9) });
  writer.label(highRisk ? "STATUS: ACTION NEEDED" : "STATUS: STABLE", margin + 13, writer.y - 15, highRisk ? danger : forest);
  writer.text(highRisk ? "Review the three priorities below before placing new orders." : "No critical intervention is currently required.", margin + 13, writer.y - 29, { size: 9, color: muted });
  writer.y -= 57;

  const metricGap = 8;
  const metricWidth = (contentWidth - metricGap) / 2;
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Safe to spend", money(analysis.summary.purchasingCapacity), forest);
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Cash reserve protected", money(analysis.summary.reserve));
  writer.y -= 61;
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Payments to recover", money(analysis.summary.overdueReceivables), amber);
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "13-week cash runway", analysis.cashRunway.shortageWeek ? `Reserve gap in week ${analysis.cashRunway.shortageWeek}` : "Reserve protected", analysis.cashRunway.shortageWeek ? danger : forest);
  writer.y -= 72;

  writer.section("What the owner should do next");
  analysis.actions.forEach((action, index) => drawPriority(writer, action, index));

  writer.newPage();
  drawReportHeader(writer, input.businessName, reportDate);
  writer.label("13-WEEK CASH RUNWAY", margin, writer.y, forest);
  writer.y -= 24;
  writer.heading(analysis.cashRunway.shortageWeek ? `Cash pressure is projected in week ${analysis.cashRunway.shortageWeek}` : "The conservative cash outlook protects your reserve");
  writer.paragraph("This projection starts with available cash, discounts uncertain customer receipts, subtracts committed obligations and includes the proposed priority purchase.", { size: 10, color: muted, gapAfter: 13 });
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Lowest conservative balance", money(analysis.cashRunway.minimumConservativeBalance), analysis.cashRunway.cashGap ? danger : forest);
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Reserve gap", analysis.cashRunway.cashGap ? money(analysis.cashRunway.cashGap) : "No gap", analysis.cashRunway.cashGap ? danger : forest);
  writer.y -= 64;
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Expected receipts", money(analysis.cashRunway.totalExpectedInflows));
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Outflows incl. order", money(analysis.cashRunway.totalCommittedOutflows), amber);
  writer.y -= 70;
  writer.section("Weekly conservative view", `${analysis.cashRunway.confidence} confidence. A red balance is below the protected reserve of ${money(analysis.summary.reserve)}.`);
  writer.label("WEEK", margin, writer.y, muted);
  writer.label("EXPECTED IN", margin + 75, writer.y, muted);
  writer.label("OUT", margin + 175, writer.y, muted);
  writer.label("EXPECTED BALANCE", margin + 255, writer.y, muted);
  writer.label("CONSERVATIVE", margin + 390, writer.y, muted);
  writer.y -= 13;
  for (const week of analysis.cashRunway.weeks) {
    writer.page.drawLine({ start: { x: margin, y: writer.y - 4 }, end: { x: pageWidth - margin, y: writer.y - 4 }, thickness: .45, color: line });
    writer.text(`W${week.week}  ${week.label}`, margin, writer.y + 2, { size: 7.5, bold: true });
    writer.text(money(week.expectedInflows), margin + 75, writer.y + 2, { size: 7.5, color: muted });
    writer.text(money(week.committedOutflows + week.proposedPurchases), margin + 175, writer.y + 2, { size: 7.5, color: muted });
    writer.text(money(week.expectedBalance), margin + 255, writer.y + 2, { size: 7.5 });
    writer.text(money(week.conservativeBalance), margin + 390, writer.y + 2, { size: 7.5, bold: true, color: week.conservativeBalance < analysis.summary.reserve ? danger : forest });
    writer.y -= 18;
  }
  writer.y -= 6;
  writer.section("Assumptions the owner should know");
  for (const assumption of analysis.cashRunway.assumptions) writer.paragraph(`- ${assumption}`, { x: margin + 8, width: contentWidth - 8, size: 8.3, color: muted, gapAfter: 2 });

  writer.newPage();
  drawReportHeader(writer, input.businessName, reportDate);
  writer.label("DETAILED BUSINESS POSITION", margin, writer.y, forest);
  writer.y -= 24;
  writer.heading("Why Argus reached these decisions");
  writer.paragraph(`Inventory requires ${analysis.reorder.requiredUnits} units of ${analysis.reorder.sku}; the verified cash constraints fund ${analysis.reorder.approvedUnits} units now. Every external action remains owner-approved.`, { size: 10, color: muted, gapAfter: 12 });

  writer.section("Data confidence", "This section explains whether the uploaded information was reliable enough to support the report.");
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Usable records", analysis.quality.validRows.toLocaleString("en-IN"));
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Product coverage", `${analysis.quality.coverage}% matched`, analysis.quality.coverage >= 90 ? forest : amber);
  writer.y -= 64;
  writer.paragraph(`${analysis.quality.rejectedRows} rows were rejected and ${analysis.quality.duplicates} exact duplicates were isolated.`, { size: 9, gapAfter: 5 });
  for (const warning of analysis.quality.warnings.slice(0, 6)) writer.paragraph(`- ${warning}`, { x: margin + 8, width: contentWidth - 8, size: 8.5, color: muted, gapAfter: 2 });

  const costReport = analysis.quant?.costIntelligence;
  writer.section("Cost intelligence", costReport ? `${costReport.model}. ML identifies unusual patterns; verified formulas calculate financial exposure.` : "Cost intelligence was not present in this older analysis snapshot.");
  if (costReport?.findings[0]) {
    const finding = costReport.findings[0];
    writer.paragraph(`${finding.productName} / ${finding.supplierName}`, { size: 12, bold: true, gapAfter: 3 });
    writer.paragraph(`Quoted cost ${money(finding.actualCost)} versus expected range ${money(finding.expectedLower)}-${money(finding.expectedUpper)}. Estimated 30-day margin exposure: ${money(finding.marginAtRisk30)}.`, { size: 9, color: muted, gapAfter: 3 });
    writer.paragraph(`${finding.marginErosionPoints.toFixed(1)} gross-margin points at risk / ${finding.confidence}% confidence. ${finding.likelyDriver}`, { size: 8.5, bold: true, color: forest, gapAfter: 6 });
  } else writer.paragraph("No material supplier-cost anomaly crossed the current verified threshold.", { size: 9, color: muted, gapAfter: 6 });

  writer.section("Decision evidence");
  for (const action of analysis.actions) {
    writer.ensure(98);
    writer.paragraph(action.title, { size: 12, bold: true, gapAfter: 3 });
    writer.paragraph(action.reason, { size: 9, color: muted, gapAfter: 4 });
    for (const evidence of action.evidence) writer.paragraph(`- ${evidence}`, { x: margin + 8, width: contentWidth - 8, size: 8.2, color: muted, gapAfter: 1 });
    writer.paragraph(`Expected impact: ${action.impact}`, { x: margin + 8, width: contentWidth - 8, size: 8.5, bold: true, color: forest, gapAfter: 10 });
  }

  writer.newPage();
  drawReportHeader(writer, input.businessName, reportDate);
  writer.label("UNUSUAL ACTIVITY REPORT", margin, writer.y, forest);
  writer.y -= 24;
  writer.heading(`${analysis.anomalies.findings.length} pattern${analysis.anomalies.findings.length === 1 ? "" : "s"} require verification`);
  writer.paragraph("An anomaly means unusual, not automatically wrong. The owner should verify the business context before changing a forecast or action.", { size: 10, color: muted, gapAfter: 12 });
  if (!analysis.anomalies.findings.length) writer.paragraph("No material anomaly crossed the current deterministic thresholds.", { size: 11, bold: true });
  for (const finding of analysis.anomalies.findings) {
    writer.ensure(130);
    writer.page.drawRectangle({ x: margin, y: writer.y - 4, width: 4, height: 22, color: finding.severity === "Critical" || finding.severity === "High" ? danger : amber });
    const sourceLabel = finding.detectionSource === "ml" ? "ML PREDICTED" : "DETERMINISTIC RULE";
    writer.paragraph(`${finding.severity.toUpperCase()} / ${finding.category.toUpperCase()} / ${sourceLabel} / ${finding.confidence}% CONFIDENCE`, { x: margin + 12, width: contentWidth - 12, size: 7.5, bold: true, color: finding.severity === "Critical" || finding.severity === "High" ? danger : amber, gapAfter: 4 });
    writer.paragraph(finding.title, { x: margin + 12, width: contentWidth - 12, size: 13, bold: true, gapAfter: 3 });
    writer.paragraph(finding.summary, { x: margin + 12, width: contentWidth - 12, size: 9, color: muted, gapAfter: 4 });
    writer.paragraph(`Observed: ${finding.actual} | Expected: ${finding.expected}`, { x: margin + 12, width: contentWidth - 12, size: 8.5, bold: true, gapAfter: 3 });
    writer.paragraph(`Why flagged: ${finding.whyFlagged}`, { x: margin + 12, width: contentWidth - 12, size: 8.5, color: muted, gapAfter: 3 });
    writer.paragraph(`Detection method: ${finding.detector || "Legacy deterministic analysis"}`, { x: margin + 12, width: contentWidth - 12, size: 8.2, bold: true, color: forest, gapAfter: 3 });
    for (const evidence of finding.evidence) writer.paragraph(`- ${evidence}`, { x: margin + 20, width: contentWidth - 20, size: 8, color: muted, gapAfter: 1 });
    writer.paragraph(`Owner check: ${finding.recommendedCheck}`, { x: margin + 12, width: contentWidth - 12, size: 8.5, bold: true, color: forest, gapAfter: 12 });
  }

  writer.newPage();
  drawReportHeader(writer, input.businessName, reportDate);
  writer.label("WEEKLY VALUE AND CONTROL", margin, writer.y, forest);
  writer.y -= 24;
  writer.heading("What actually happened this week");
  writer.paragraph("Only owner-recorded outcomes appear as measured value. Forecast impact remains clearly labelled as an estimate.", { size: 10, color: muted, gapAfter: 16 });
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Measured value", money(weekly.measuredValue), forest);
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Outcomes recorded", String(weekly.outcomes));
  writer.y -= 64;
  drawMetric(writer, margin, writer.y - 53, metricWidth, "Owner approvals", String(weekly.approvals));
  drawMetric(writer, margin + metricWidth + metricGap, writer.y - 53, metricWidth, "Autonomous actions", String(weekly.autonomousActions), weekly.autonomousActions ? danger : forest);
  writer.y -= 72;
  writer.section("Outcome breakdown");
  writer.paragraph(`- ${weekly.paymentsReceived} payment outcome${weekly.paymentsReceived === 1 ? "" : "s"} recorded`, { size: 10, gapAfter: 4 });
  writer.paragraph(`- ${weekly.stockoutRisksAddressed} stockout risk${weekly.stockoutRisksAddressed === 1 ? "" : "s"} addressed`, { size: 10, gapAfter: 4 });
  writer.paragraph(`- ${weekly.purchasesAvoided} excess purchase${weekly.purchasesAvoided === 1 ? "" : "s"} avoided`, { size: 10, gapAfter: 14 });
  writer.section("Owner-control statement");
  writer.paragraph("Argus provides decision support. It does not send a customer message, place a supplier order or claim a saving without owner approval and a recorded outcome.", { size: 10, color: muted, gapAfter: 8 });
  writer.paragraph("Forecast impact is an estimate, not guaranteed revenue or savings. Verify physical stock, supplier commitments and customer context before acting.", { size: 9, color: muted });

  const pages = document.getPages();
  pages.forEach((page, index) => {
    page.drawLine({ start: { x: margin, y: 40 }, end: { x: pageWidth - margin, y: 40 }, thickness: .6, color: line });
    page.drawText("ARGUS / VERIFIED BUSINESS REPORT", { x: margin, y: 25, size: 6.5, font: bold, color: muted });
    const pageText = `${index + 1} / ${pages.length}`;
    page.drawText(pageText, { x: pageWidth - margin - regular.widthOfTextAtSize(pageText, 6.5), y: 25, size: 6.5, font: regular, color: muted });
  });

  return document.save();
}

function reportPackage(analysis: UploadAnalysis): DecisionPackage {
  return {
    snapshot: { quality: analysis.quality, summary: analysis.summary, cash_runway: analysis.cashRunway, anomaly_report: analysis.anomalies, quant: analysis.quant },
    specialist_assessments: analysis.agents,
    verified_actions: analysis.actions,
    optimizer: analysis.reorder,
  };
}

function unicodeLines(value: string, font: PDFFont, size: number, width: number) {
  const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

async function buildLocalizedBusinessReportPdf(input: { businessName: string; analysis: UploadAnalysis; weekly: WeeklyReportSummary; languageCode: LanguageCode; localizedReport?: LocalizedDecisionReport | null; fontBytes?: Uint8Array }) {
  if (!input.fontBytes?.length) throw new Error("An embedded Indic font is required for multilingual PDF export.");
  const decisionPackage = reportPackage(input.analysis);
  const supplied = input.localizedReport;
  const report = supplied?.languageCode === input.languageCode && validateLocalizedReport(supplied, decisionPackage).valid
    ? supplied
    : buildDeterministicLocalizedReport(decisionPackage, input.languageCode);
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  // Full embedding avoids subset incompatibilities in variable Indic fonts and
  // preserves complex-script glyph positioning.
  const font = await document.embedFont(input.fontBytes, { subset: false });
  document.setTitle(`${input.businessName} - ${report.title}`);
  document.setAuthor("Argus Working Capital Copilot");
  document.setSubject(report.summary);
  const addPage = () => document.addPage([pageWidth, pageHeight]);
  const drawParagraph = (page: PDFPage, value: string, y: number, size = 11, color = ink, bold = false, x = margin, width = contentWidth) => {
    const lines = unicodeLines(value, font, size, width);
    lines.forEach((lineText, index) => page.drawText(lineText, { x, y: y - index * size * 1.48, size, font, color }));
    return y - lines.length * size * 1.48 - (bold ? 5 : 2);
  };
  const header = (page: PDFPage, pageNumber: number) => {
    page.drawRectangle({ x: margin, y: pageHeight - 73, width: 29, height: 29, color: forest });
    page.drawText("A", { x: margin + 9, y: pageHeight - 64, size: 14, font, color: green });
    page.drawText("ARGUS", { x: margin + 40, y: pageHeight - 56, size: 12, font, color: ink });
    page.drawText(input.businessName, { x: margin + 40, y: pageHeight - 70, size: 8, font, color: muted });
    page.drawText(input.analysis.anomalies.reportDate, { x: pageWidth - margin - 75, y: pageHeight - 62, size: 8, font, color: muted });
    page.drawLine({ start: { x: margin, y: 40 }, end: { x: pageWidth - margin, y: 40 }, thickness: .6, color: line });
    page.drawText(`${pageNumber}`, { x: pageWidth - margin - 10, y: 25, size: 7, font, color: muted });
  };

  const pageOne = addPage();
  header(pageOne, 1);
  let y = pageHeight - 112;
  y = drawParagraph(pageOne, report.title, y, 23, forest, true);
  y -= 10;
  y = drawParagraph(pageOne, report.summary, y, 13, ink);
  y -= 12;
  pageOne.drawRectangle({ x: margin, y: y - 86, width: contentWidth, height: 94, color: soft, borderColor: line, borderWidth: .6 });
  y = drawParagraph(pageOne, report.riskSummary, y - 18, 12, danger, true, margin + 15, contentWidth - 30);
  y -= 14;
  y = drawParagraph(pageOne, report.methodology, y, 10.5, muted);
  y -= 10;
  y = drawParagraph(pageOne, report.ownerControl, y, 11.5, forest, true);
  y -= 16;
  drawParagraph(pageOne, report.sourceNote, y, 9.5, muted);

  const pageTwo = addPage();
  header(pageTwo, 2);
  y = pageHeight - 112;
  y = drawParagraph(pageTwo, report.title, y, 17, forest, true);
  y -= 8;
  report.actions.forEach((action, index) => {
    const blockTop = y;
    const titleLines = unicodeLines(`${index + 1}. ${action.title}`, font, 14, contentWidth - 28);
    const reasonLines = unicodeLines(action.reason, font, 10, contentWidth - 28);
    const impactLines = unicodeLines(action.impact, font, 10, contentWidth - 28);
    const evidenceLines = action.evidence.flatMap((item) => unicodeLines(`• ${item}`, font, 9, contentWidth - 42));
    const height = 38 + titleLines.length * 21 + (reasonLines.length + impactLines.length) * 15 + evidenceLines.length * 13;
    if (blockTop - height < 70) return;
    pageTwo.drawRectangle({ x: margin, y: blockTop - height, width: contentWidth, height, color: rgb(1, 1, 1), borderColor: line, borderWidth: .7 });
    let blockY = blockTop - 19;
    titleLines.forEach((lineText) => { pageTwo.drawText(lineText, { x: margin + 14, y: blockY, size: 14, font, color: forest }); blockY -= 21; });
    reasonLines.forEach((lineText) => { pageTwo.drawText(lineText, { x: margin + 14, y: blockY, size: 10, font, color: ink }); blockY -= 15; });
    impactLines.forEach((lineText) => { pageTwo.drawText(lineText, { x: margin + 14, y: blockY, size: 10, font, color: forest }); blockY -= 15; });
    evidenceLines.forEach((lineText) => { pageTwo.drawText(lineText, { x: margin + 24, y: blockY, size: 9, font, color: muted }); blockY -= 13; });
    y = blockTop - height - 12;
  });

  const pageThree = addPage();
  header(pageThree, 3);
  y = pageHeight - 112;
  y = drawParagraph(pageThree, report.methodology, y, 15, forest, true);
  y -= 15;
  for (const warning of report.warnings) {
    pageThree.drawRectangle({ x: margin, y: y - 9, width: 5, height: 19, color: amber });
    y = drawParagraph(pageThree, warning, y, 11, ink, false, margin + 15, contentWidth - 15);
    y -= 9;
  }
  y -= 10;
  y = drawParagraph(pageThree, report.ownerControl, y, 13, forest, true);
  y -= 16;
  y = drawParagraph(pageThree, report.sourceNote, y, 10, muted);
  y -= 20;
  drawParagraph(pageThree, report.riskSummary, y, 11, danger);

  return document.save();
}
