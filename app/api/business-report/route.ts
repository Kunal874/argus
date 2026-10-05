import { getLatestAnalysisSnapshot, getWeeklySummary } from "@/db/argus-store";
import { buildBusinessReportPdf } from "@/lib/business-report";
import { projectCashRunway, type UploadAnalysis } from "@/lib/client-analysis";
import { getLanguage, normalizeLanguageCode } from "@/lib/languages";
import type { LocalizedDecisionReport } from "@/lib/multilingual-report";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

async function generate(request: Request, localizedReport?: LocalizedDecisionReport | null) {
  try {
    const principal = await requirePrincipal(request, "reports:download");
    const url = new URL(request.url);
    const businessId = principal.tenantId;
    const languageCode = normalizeLanguageCode(url.searchParams.get("language"));
    const snapshot = await getLatestAnalysisSnapshot<UploadAnalysis>(businessId);
    if (!snapshot) return Response.json({ error: "Run an analysis before generating the report." }, { status: 404 });
    if (!snapshot.snapshot.cashRunway) snapshot.snapshot.cashRunway = projectCashRunway({
      asOfDate: snapshot.snapshot.anomalies.reportDate,
      availableCash: snapshot.snapshot.summary.availableCash,
      reserve: snapshot.snapshot.summary.reserve,
      proposedPurchase: snapshot.snapshot.actions.find((action) => action.type === "reorder")?.amount ?? 0,
      receivables: [], obligations: [], obligationsProvided: false,
    });
    const weekly = await getWeeklySummary(businessId);
    const language = getLanguage(languageCode);
    let fontBytes: Uint8Array | undefined;
    if (language.fontFile) {
      const fontResponse = await fetch(new URL(`/fonts/${language.fontFile}`, request.url));
      if (!fontResponse.ok) throw new Error(`Could not load the ${language.englishName} report font.`);
      fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
    }
    const pdf = await buildBusinessReportPdf({ businessName: "Mehra Electricals", analysis: snapshot.snapshot, weekly, languageCode, localizedReport, fontBytes });
    const safeDate = snapshot.reportDate.replace(/[^0-9-]/g, "");
    return new Response(pdf as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="argus-business-report-${languageCode}-${safeDate || "latest"}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    console.error("Business report generation failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Could not generate the business report." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return generate(request);
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 80_000) return Response.json({ error: "Localized report payload is too large." }, { status: 413 });
    const body = await request.json() as { localizedReport?: LocalizedDecisionReport | null };
    return generate(request, body.localizedReport);
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
}
