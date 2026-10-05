import { NextResponse } from "next/server";
import { getVerifiedAction, hasApproval, recordOutcome } from "@/db/argus-store";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

const allowedOutcomes = new Set(["stockout_avoided", "payment_received", "purchase_avoided", "margin_protected", "other"]);
const allowedActionTypes = new Set(["reorder", "collection", "defer", "cost_control"]);

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "outcomes:write");
    const body = await request.json() as Record<string, unknown>;
    const amount = Number(body.amount ?? 0);
    const input = {
      businessId: principal.tenantId,
      actionId: String(body.actionId ?? "").trim(),
      actionType: String(body.actionType ?? "").trim(),
      outcomeType: String(body.outcomeType ?? "").trim(),
      amount,
      notes: String(body.notes ?? "").trim(),
    };
    if (!input.actionId || !allowedActionTypes.has(input.actionType) || !allowedOutcomes.has(input.outcomeType) || !Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "Enter a valid outcome." }, { status: 400 });
    }
    const verifiedAction = await getVerifiedAction(input.businessId, input.actionId);
    if (!verifiedAction || verifiedAction.type !== input.actionType) {
      return NextResponse.json({ error: "This outcome does not match the latest verified analysis." }, { status: 409 });
    }
    if (!await hasApproval(input.businessId, input.actionId)) {
      return NextResponse.json({ error: "Record owner approval before recording an outcome." }, { status: 409 });
    }
    const outcome = await recordOutcome(input);
    return NextResponse.json({ recorded: true, ...outcome });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    return NextResponse.json({ error: "Could not record outcome." }, { status: 500 });
  }
}
