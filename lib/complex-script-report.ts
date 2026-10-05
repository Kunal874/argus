import PDFKitDocument from "pdfkit";
import type { UploadAnalysis } from "./client-analysis";
import type { LanguageCode } from "./languages";
import { buildDeterministicLocalizedReport, validateLocalizedReport, type LocalizedDecisionReport } from "./multilingual-report";
import type { DecisionPackage } from "./reasoning";

type WeeklySummary = {
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

function reportPackage(analysis: UploadAnalysis): DecisionPackage {
  return {
    snapshot: { quality: analysis.quality, summary: analysis.summary, cash_runway: analysis.cashRunway, anomaly_report: analysis.anomalies, quant: analysis.quant },
    specialist_assessments: analysis.agents,
    verified_actions: analysis.actions,
    optimizer: analysis.reorder,
  };
}

export async function buildComplexScriptBusinessReportPdf(input: {
  businessName: string;
  analysis: UploadAnalysis;
  weekly: WeeklySummary;
  languageCode: LanguageCode;
  localizedReport?: LocalizedDecisionReport | null;
  fontBytes?: Uint8Array;
}) {
  if (!input.fontBytes?.length) throw new Error("An embedded Indic font is required for multilingual PDF export.");
  const decisionPackage = reportPackage(input.analysis);
  const supplied = input.localizedReport;
  const report = supplied?.languageCode === input.languageCode && validateLocalizedReport(supplied, decisionPackage).valid
    ? supplied
    : buildDeterministicLocalizedReport(decisionPackage, input.languageCode);
  const document = new PDFKitDocument({
    size: "A4",
    margin,
    info: {
      Title: `${input.businessName} - ${report.title}`,
      Author: "Argus Working Capital Copilot",
      Subject: report.summary,
    },
  });
  const chunks: Uint8Array[] = [];
  document.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const completed = new Promise<Uint8Array>((resolve, reject) => {
    document.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    document.on("error", reject);
  });
  document.registerFont("Indic", Buffer.from(input.fontBytes));

  const colors = { ink: "#0e1c18", forest: "#0a4336", green: "#abd169", soft: "#f5f7f0", line: "#d6dbd4", muted: "#57665f", amber: "#ab630d", danger: "#ab381f", white: "#ffffff" };
  const splitRuns = (value: string) => String(value ?? "").replace(/\s+/g, " ").trim().split(/([\u0020-\u024f]+)/u).filter(Boolean);
  const richText = (value: string, options: { x?: number; y?: number; width?: number; size?: number; color?: string; bold?: boolean; lineGap?: number } = {}) => {
    const runs = splitRuns(value);
    const x = options.x ?? margin;
    const y = options.y ?? document.y;
    const width = options.width ?? contentWidth;
    document.x = x;
    document.y = y;
    runs.forEach((run, index) => {
      const latin = /^[\u0020-\u024f]+$/u.test(run);
      const writer = document.font(latin ? (options.bold ? "Helvetica-Bold" : "Helvetica") : "Indic")
        .fontSize(options.size ?? 11)
        .fillColor(options.color ?? colors.ink);
      const textOptions = { lineGap: options.lineGap ?? 3, continued: index < runs.length - 1 };
      if (index === 0) writer.text(run, x, y, { ...textOptions, width });
      else writer.text(run, textOptions);
    });
    return document.y;
  };
  const header = (pageNumber: number) => {
    document.save().rect(margin, 45, 29, 29).fill(colors.forest).restore();
    document.font("Helvetica-Bold").fontSize(14).fillColor(colors.green).text("A", margin + 9, 53, { lineBreak: false });
    document.font("Helvetica-Bold").fontSize(12).fillColor(colors.ink).text("ARGUS", margin + 40, 48, { lineBreak: false });
    document.font("Helvetica").fontSize(8).fillColor(colors.muted).text(input.businessName, margin + 40, 64, { width: 300, lineBreak: false });
    document.font("Helvetica").fontSize(8).fillColor(colors.muted).text(input.analysis.anomalies.reportDate, pageWidth - margin - 76, 55, { width: 76, align: "right", lineBreak: false });
    document.moveTo(margin, pageHeight - 40).lineTo(pageWidth - margin, pageHeight - 40).lineWidth(.6).stroke(colors.line);
    document.font("Helvetica").fontSize(7).fillColor(colors.muted).text(String(pageNumber), pageWidth - margin - 10, pageHeight - 31, { lineBreak: false });
  };
  const newPage = (pageNumber: number) => {
    if (pageNumber > 1) document.addPage();
    header(pageNumber);
    document.x = margin;
    document.y = 108;
  };

  newPage(1);
  richText(report.title, { size: 23, color: colors.forest, bold: true, lineGap: 6 });
  document.moveDown(.55);
  richText(report.summary, { size: 13, lineGap: 5 });
  document.moveDown(.75);
  const riskTop = document.y;
  document.save().roundedRect(margin, riskTop, contentWidth, 104, 4).fillAndStroke(colors.soft, colors.line).restore();
  richText(report.riskSummary, { x: margin + 15, y: riskTop + 18, width: contentWidth - 30, size: 12, color: colors.danger, bold: true, lineGap: 4 });
  document.y = riskTop + 126;
  richText(report.methodology, { size: 10.5, color: colors.muted, lineGap: 4 });
  document.moveDown(.7);
  richText(report.ownerControl, { size: 11.5, color: colors.forest, bold: true, lineGap: 4 });
  document.moveDown(.8);
  richText(report.sourceNote, { size: 9.5, color: colors.muted, lineGap: 3 });

  newPage(2);
  richText(report.title, { size: 17, color: colors.forest, bold: true, lineGap: 4 });
  document.moveDown(.7);
  report.actions.forEach((action, index) => {
    const cardTop = document.y;
    const cardHeight = 184;
    document.save().roundedRect(margin, cardTop, contentWidth, cardHeight, 4).fillAndStroke(colors.white, colors.line).restore();
    richText(`${index + 1}. ${action.title}`, { x: margin + 14, y: cardTop + 14, width: contentWidth - 28, size: 13.5, color: colors.forest, bold: true, lineGap: 3 });
    document.moveDown(.35);
    richText(action.reason, { x: margin + 14, width: contentWidth - 28, size: 9.8, lineGap: 3 });
    document.moveDown(.3);
    richText(action.impact, { x: margin + 14, width: contentWidth - 28, size: 9.8, color: colors.forest, bold: true, lineGap: 3 });
    document.moveDown(.25);
    action.evidence.slice(0, 3).forEach((item) => richText(`- ${item}`, { x: margin + 23, width: contentWidth - 42, size: 8.8, color: colors.muted, lineGap: 2 }));
    document.y = cardTop + cardHeight + 12;
  });

  newPage(3);
  richText(report.methodology, { size: 15, color: colors.forest, bold: true, lineGap: 5 });
  document.moveDown(.9);
  for (const warning of report.warnings) {
    const warningTop = document.y;
    document.save().rect(margin, warningTop + 2, 5, 23).fill(colors.amber).restore();
    richText(warning, { x: margin + 15, y: warningTop, width: contentWidth - 15, size: 11, lineGap: 4 });
    document.moveDown(.65);
  }
  document.moveDown(.5);
  richText(report.ownerControl, { size: 13, color: colors.forest, bold: true, lineGap: 5 });
  document.moveDown(.85);
  richText(report.sourceNote, { size: 10, color: colors.muted, lineGap: 4 });
  document.moveDown(1);
  richText(report.riskSummary, { size: 11, color: colors.danger, lineGap: 4 });

  document.end();
  return completed;
}
