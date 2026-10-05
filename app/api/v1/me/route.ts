import { authErrorResponse, requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request, "business:read");
    return Response.json({ userId: principal.userId, activeOrganizationId: principal.tenantId, role: principal.role, permissions: principal.permissions, provider: principal.provider });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: "Authentication failed." }, { status: 500 });
  }
}
