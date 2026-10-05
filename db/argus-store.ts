import { env } from "cloudflare:workers";
import { compactAnalysisSnapshot } from "@/lib/snapshot";

type OutcomeInput = {
  businessId: string;
  actionId: string;
  actionType: string;
  outcomeType: string;
  amount: number;
  notes?: string;
};

export type StoredVerifiedAction = {
  id: string;
  type: "reorder" | "collection" | "defer" | "cost_control";
  title: string;
  amount: number;
  meta?: Record<string, string | number | boolean>;
};

async function ensureSchema() {
  const db = env.DB;
  if (!db) throw new Error("Outcome storage is unavailable.");
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, action_id TEXT NOT NULL, action_type TEXT NOT NULL, relationship_action TEXT, sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS approvals_business_created_idx ON approvals (business_id, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, action_id TEXT NOT NULL, action_type TEXT NOT NULL, outcome_type TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS outcomes_business_created_idx ON outcomes (business_id, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS analysis_snapshots (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, report_date TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS analysis_snapshots_business_created_idx ON analysis_snapshots (business_id, created_at)"),
  ]);
  return db;
}

export async function recordAnalysisSnapshot(input: { businessId: string; reportDate: string; snapshot: unknown }) {
  const db = await ensureSchema();
  const snapshotJson = JSON.stringify(compactAnalysisSnapshot(input.snapshot));
  if (snapshotJson.length > 1_000_000) throw new Error("Analysis snapshot is too large.");
  const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db.prepare("INSERT INTO analysis_snapshots (id, business_id, report_date, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, input.businessId, input.reportDate, snapshotJson, row.createdAt).run();
  return row;
}

export async function getLatestAnalysisSnapshot<T>(businessId: string): Promise<{ id: string; reportDate: string; snapshot: T; createdAt: string } | null> {
  const db = await ensureSchema();
  const row = await db.prepare("SELECT id, report_date, snapshot_json, created_at FROM analysis_snapshots WHERE business_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(businessId).first<{ id: string; report_date: string; snapshot_json: string; created_at: string }>();
  if (!row) return null;
  return { id: row.id, reportDate: row.report_date, snapshot: JSON.parse(row.snapshot_json) as T, createdAt: row.created_at };
}

export async function getVerifiedAction(businessId: string, actionId: string): Promise<StoredVerifiedAction | null> {
  const stored = await getLatestAnalysisSnapshot<{ actions?: StoredVerifiedAction[] }>(businessId);
  const action = stored?.snapshot.actions?.find((candidate) => candidate.id === actionId);
  if (!action || !["reorder", "collection", "defer", "cost_control"].includes(action.type) || !Number.isFinite(action.amount) || action.amount < 0) return null;
  return action;
}

export async function recordApproval(input: { businessId: string; actionId: string; actionType: string; relationshipAction?: string }) {
  const db = await ensureSchema();
  const existing = await db.prepare("SELECT id, created_at, sent FROM approvals WHERE business_id = ? AND action_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(input.businessId, input.actionId).first<{ id: string; created_at: string; sent: number }>();
  if (existing) return { id: existing.id, createdAt: existing.created_at, sent: Boolean(existing.sent), existing: true };
  const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db.prepare("INSERT INTO approvals (id, business_id, action_id, action_type, relationship_action, sent, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(row.id, input.businessId, input.actionId, input.actionType, input.relationshipAction ?? null, row.createdAt).run();
  return { ...row, sent: false, existing: false };
}

export async function hasApproval(businessId: string, actionId: string) {
  const db = await ensureSchema();
  const row = await db.prepare("SELECT id FROM approvals WHERE business_id = ? AND action_id = ? LIMIT 1")
    .bind(businessId, actionId).first<{ id: string }>();
  return Boolean(row);
}

export async function recordOutcome(input: OutcomeInput) {
  const db = await ensureSchema();
  const existing = await db.prepare("SELECT id, created_at FROM outcomes WHERE business_id = ? AND action_id = ? AND outcome_type = ? ORDER BY created_at DESC LIMIT 1")
    .bind(input.businessId, input.actionId, input.outcomeType).first<{ id: string; created_at: string }>();
  if (existing) return { id: existing.id, createdAt: existing.created_at, existing: true };
  const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db.prepare("INSERT INTO outcomes (id, business_id, action_id, action_type, outcome_type, amount, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, input.businessId, input.actionId, input.actionType, input.outcomeType, input.amount, input.notes ?? null, row.createdAt).run();
  return { ...row, existing: false };
}

export async function getWeeklySummary(businessId: string) {
  const db = await ensureSchema();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const totals = await db.prepare("SELECT COUNT(*) AS outcomes, COALESCE(SUM(amount), 0) AS measured_value FROM outcomes WHERE business_id = ? AND created_at >= ?")
    .bind(businessId, since).first<{ outcomes: number; measured_value: number }>();
  const groups = await db.prepare("SELECT outcome_type, COUNT(*) AS count FROM outcomes WHERE business_id = ? AND created_at >= ? GROUP BY outcome_type")
    .bind(businessId, since).all<{ outcome_type: string; count: number }>();
  const approvals = await db.prepare("SELECT COUNT(*) AS approvals, COALESCE(SUM(sent), 0) AS sent FROM approvals WHERE business_id = ? AND created_at >= ?")
    .bind(businessId, since).first<{ approvals: number; sent: number }>();
  return {
    outcomes: Number(totals?.outcomes ?? 0),
    measuredValue: Number(totals?.measured_value ?? 0),
    stockoutRisksAddressed: Number(groups.results.find((row) => row.outcome_type === "stockout_avoided")?.count ?? 0),
    paymentsReceived: Number(groups.results.find((row) => row.outcome_type === "payment_received")?.count ?? 0),
    purchasesAvoided: Number(groups.results.find((row) => row.outcome_type === "purchase_avoided")?.count ?? 0),
    approvals: Number(approvals?.approvals ?? 0),
    autonomousActions: Number(approvals?.sent ?? 0),
  };
}
