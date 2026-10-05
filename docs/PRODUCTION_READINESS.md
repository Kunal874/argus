# Argus production foundation

The current web application preserves the deterministic TypeScript decision engine and exactly three actions. `quant-v2` adds rolling-origin evaluation, intermittent-demand methods, calibrated metadata, complete-calendar anomaly scoring, and dated landed-cost ingestion. The Python service is a tenant-local LightGBM challenger; it does not authorize quantities, cash amounts, priorities, approvals, or external actions.

## Authentication

Production requests use a Clerk bearer token. Set `CLERK_ISSUER`, optionally `CLERK_JWKS_URL`, and `CLERK_AUDIENCE`. The server verifies the JWT and derives the tenant only from `org_id`; request bodies cannot choose a tenant. Clerk organization roles map to owner, admin, analyst, and approver permissions in `lib/server-auth.ts`. Owner/Admin/Approver MFA and step-up policies must be enabled in the Clerk dashboard before launch.

The hosted Sites compatibility path uses trusted `oai-authenticated-user-*` edge headers and isolates each account into its own tenant. This path is intentionally not a substitute for Clerk organizations. Local development receives a synthetic tenant only when `NODE_ENV` is not `production`.

## Deployment order

1. Build and push the API and model images to Artifact Registry.
2. Apply `infra/gcp` with a reviewed production tfvars file. Never commit credentials.
3. Apply `db/postgres/0001_production.sql` as the migration owner; the runtime role must not bypass RLS.
4. Store Clerk, database, webhook, and connector credentials in Secret Manager and grant only workload-specific access.
5. Configure Cloudflare to proxy `/api/v1/*` to the Mumbai Cloud Run API; keep static assets on the existing frontend.
6. Run golden parity, cross-tenant, restore, rollback, load, and DPDP lifecycle tests before traffic.

## Promotion and safety

Models move candidate → shadow → approved → champion → retired. Promotion is manual and requires at least 5% weighted error improvement, stable bias, interval coverage within five percentage points, and no replay regression in reserve breaches, excess purchases, or stockout exposure. Retain two prior champions. Every decision package records its immutable data snapshot and model manifest. The deterministic engine remains authoritative.

This repository supplies the application boundary and deployable infrastructure baseline. Vendor account creation, DNS/WAF policy, Clerk dashboard settings, India-residency legal review, external penetration testing, backup-restore evidence, and a four-week pilot are release gates—not claims made by the code.
