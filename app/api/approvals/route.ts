import { NextResponse } from "next/server";
import { getVerifiedAction, recordApproval } from "@/db/argus-store";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

const allowedTypes = new Set(["reorder", "collection", "defer", "cost_control"]);
const allowedRelationshipActions = new Set(["friendly", "payment-date", "formal", "call"]);

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "actions:approve");
    const body = await request.json() as Record<string, unknown>;
    const actionId = String(body.actionId ?? "").trim();
    const actionType = String(body.actionType ?? "").trim();
    const relationshipAction = body.relationshipAction ? String(body.relationshipAction) : undefined;
    if (!actionId || !allowedTypes.has(actionType)) return NextResponse.json({ error: "Invalid approval request." }, { status: 400 });
    if (actionType === "collection" && (!relationshipAction || !allowedRelationshipActions.has(relationshipAction))) {
      return NextResponse.json({ error: "Choose a relationship-aware collection approach first." }, { status: 400 });
    }
    const verifiedAction = await getVerifiedAction(principal.tenantId, actionId);
    if (!verifiedAction || verifiedAction.type !== actionType) {
      return NextResponse.json({ error: "This action is not part of the latest verified analysis." }, { status: 409 });
    }
    const approval = await recordApproval({ businessId: principal.tenantId, actionId, actionType, relationshipAction });
    const amount = verifiedAction.amount;
    const draft = actionType === "collection"
      ? `Hello, could you please confirm the expected payment date for the outstanding amount of ${new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number.isFinite(amount) ? amount : 0)}? This will help us schedule upcoming supply orders. Please let us know if you need any clarification from our side.`
      : undefined;
    return NextResponse.json({ approved: true, ...approval, draft, whatsappDeepLink: draft ? `https://wa.me/?text=${encodeURIComponent(draft)}` : undefined });
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    return NextResponse.json({ error: "Could not record approval." }, { status: 500 });
  }
}
