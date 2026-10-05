import { createRemoteJWKSet, jwtVerify } from "jose";

export type ArgusRole = "owner" | "admin" | "analyst" | "approver";
export type ArgusPermission = "business:read" | "business:manage" | "members:manage" | "data:upload" | "data:read" | "analysis:run" | "analysis:read" | "actions:approve" | "outcomes:write" | "reports:download" | "privacy:manage";

export type AuthPrincipal = {
  userId: string;
  tenantId: string;
  role: ArgusRole;
  permissions: ArgusPermission[];
  email?: string;
  provider: "clerk" | "sites" | "development";
};

const rolePermissions: Record<ArgusRole, ArgusPermission[]> = {
  owner: ["business:read", "business:manage", "members:manage", "data:upload", "data:read", "analysis:run", "analysis:read", "actions:approve", "outcomes:write", "reports:download", "privacy:manage"],
  admin: ["business:read", "business:manage", "members:manage", "data:upload", "data:read", "analysis:run", "analysis:read", "actions:approve", "outcomes:write", "reports:download"],
  analyst: ["business:read", "data:upload", "data:read", "analysis:run", "analysis:read", "reports:download"],
  approver: ["business:read", "data:read", "analysis:read", "actions:approve", "outcomes:write", "reports:download"],
};

export class AuthError extends Error {
  constructor(message: string, public status: 401 | 403 = 401) { super(message); }
}

const normalizeRole = (value: unknown): ArgusRole => {
  const role = String(value ?? "").replace(/^org:/, "").toLowerCase();
  return role === "admin" || role === "analyst" || role === "approver" ? role : "owner";
};

async function clerkPrincipal(request: Request): Promise<AuthPrincipal | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const issuer = process.env.CLERK_ISSUER?.replace(/\/$/, "");
  if (!issuer) throw new AuthError("Clerk authentication is not configured.");
  const jwks = createRemoteJWKSet(new URL(process.env.CLERK_JWKS_URL || `${issuer}/.well-known/jwks.json`));
  const audience = process.env.CLERK_AUDIENCE;
  const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer, ...(audience ? { audience } : {}) });
  const tenantId = String(payload.org_id ?? "").trim();
  if (!payload.sub || !tenantId) throw new AuthError("Select a business before continuing.", 403);
  const role = normalizeRole(payload.org_role);
  const claimed = Array.isArray(payload.org_permissions) ? payload.org_permissions.map(String) : [];
  const allowed = rolePermissions[role];
  const permissions = claimed.length ? allowed.filter((permission) => claimed.includes(permission) || claimed.includes(`org:${permission}`)) : allowed;
  return { userId: payload.sub, tenantId, role, permissions, email: typeof payload.email === "string" ? payload.email : undefined, provider: "clerk" };
}

function sitesPrincipal(request: Request): AuthPrincipal | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (!userId || !email) return null;
  return { userId, email, tenantId: `sites:${userId}`, role: "owner", permissions: rolePermissions.owner, provider: "sites" };
}

export async function requirePrincipal(request: Request, permission: ArgusPermission): Promise<AuthPrincipal> {
  let principal: AuthPrincipal | null = null;
  try { principal = await clerkPrincipal(request); } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("The authentication token is invalid or expired.");
  }
  principal ??= sitesPrincipal(request);
  if (!principal && process.env.NODE_ENV !== "production") {
    principal = { userId: "local-developer", tenantId: "local-development", role: "owner", permissions: rolePermissions.owner, provider: "development" };
  }
  if (!principal) throw new AuthError("Sign in to continue.");
  if (!principal.permissions.includes(permission)) throw new AuthError("You do not have permission to perform this action.", 403);
  return principal;
}

export const authErrorResponse = (error: unknown) => error instanceof AuthError
  ? Response.json({ error: error.message }, { status: error.status })
  : null;
