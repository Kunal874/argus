import { NextResponse } from "next/server";
import { getWeeklySummary } from "@/db/argus-store";
import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request, "analysis:read");
    return NextResponse.json(await getWeeklySummary(principal.tenantId));
  } catch (error) {
    const auth = authErrorResponse(error); if (auth) return auth;
    return NextResponse.json({ error: "Could not load the weekly summary." }, { status: 500 });
  }
}
