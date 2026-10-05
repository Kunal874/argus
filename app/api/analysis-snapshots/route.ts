import { NextResponse } from "next/server";
import { recordAnalysisSnapshot } from "@/db/argus-store";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

const allowedActionTypes = new Set(["reorder", "collection", "defer", "cost_control"]);

function isSnapshot(value: unknown): value is { actions: Array<{ id: string; type: string; amount: number; confidence: number }>; summary: object; quality: { analysisReady: boolean }; anomalies: { reportDate?: string } } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { actions?: Array<Record<string, unknown>>; summary?: unknown; quality?: { analysisReady?: unknown }; anomalies?: unknown };
  if (!Array.isArray(candidate.actions) || candidate.actions.length !== 3 || !candidate.summary || !candidate.quality?.analysisReady || !candidate.anomalies) return false;
  const ids = new Set<string>();
  return candidate.actions.every((action) => {
    const id = String(action.id ?? "").trim();
    const type = String(action.type ?? "");
    const amount = Number(action.amount);
    const confidence = Number(action.confidence);
    if (!id || ids.has(id) || !allowedActionTypes.has(type) || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) return false;
    ids.add(id);
    return true;
  });
}

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "analysis:run");
    const body = await request.json() as Record<string, unknown>;
    if (!isSnapshot(body.analysis)) return NextResponse.json({ error: "A verified analysis is required." }, { status: 400 });
    const reportDate = String(body.analysis.anomalies.reportDate ?? new Date().toISOString().slice(0, 10));
    const snapshot = await recordAnalysisSnapshot({ businessId: principal.tenantId, reportDate, snapshot: body.analysis });
    return NextResponse.json({ saved: true, ...snapshot });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    return NextResponse.json({ error: "Could not save the analysis snapshot." }, { status: 500 });
  }
}
