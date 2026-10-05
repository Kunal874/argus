import { NextResponse } from "next/server";
import { compactDecisionPackage, deterministicExplanation, isValidDecisionPackage } from "@/lib/reasoning";
import { runReasoningGraph } from "@/lib/reasoning-graph";
import { normalizeLanguageCode } from "@/lib/languages";
import { buildDeterministicLocalizedReport, validateLocalizedReport } from "@/lib/multilingual-report";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

export async function POST(request: Request) {
  try { await requirePrincipal(request, "analysis:run"); } catch (error) { return authErrorResponse(error)!; }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const envelope = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const rawPackage = envelope.decisionPackage ?? body;
  const languageCode = normalizeLanguageCode(envelope.languageCode);
  if (!isValidDecisionPackage(rawPackage)) return NextResponse.json({ error: "A verified package with exactly three actions is required." }, { status: 400 });
  const fallback = deterministicExplanation(compactDecisionPackage(rawPackage));
  try {
    return NextResponse.json(await runReasoningGraph(rawPackage, { languageCode }));
  } catch (error) {
    console.error("Reasoning graph failure:", error instanceof Error ? error.message : "unknown graph error");
    const compact = compactDecisionPackage(rawPackage);
    const localizedReport = buildDeterministicLocalizedReport(compact, languageCode);
    return NextResponse.json({
      explanation: languageCode === "en" ? fallback : [localizedReport.summary, localizedReport.riskSummary, localizedReport.ownerControl].join(" "),
      mode: "deterministic-fallback-after-provider-error",
      verified: true,
      languageCode,
      localizedReport,
      multilingualValidation: validateLocalizedReport(localizedReport, compact),
    });
  }
}
