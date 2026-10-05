import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  actionId: text("action_id").notNull(),
  actionType: text("action_type").notNull(),
  relationshipAction: text("relationship_action"),
  sent: integer("sent", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
}, (table) => [index("approvals_business_created_idx").on(table.businessId, table.createdAt)]);

export const outcomes = sqliteTable("outcomes", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  actionId: text("action_id").notNull(),
  actionType: text("action_type").notNull(),
  outcomeType: text("outcome_type").notNull(),
  amount: real("amount").notNull().default(0),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("outcomes_business_created_idx").on(table.businessId, table.createdAt)]);

export const analysisSnapshots = sqliteTable("analysis_snapshots", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull(),
  reportDate: text("report_date").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("analysis_snapshots_business_created_idx").on(table.businessId, table.createdAt)]);
