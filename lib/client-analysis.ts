import { analyzeCosts, detectDemandAnomaly, forecastDemand, type CostIntelligenceReport, type DemandAnomalyPrediction, type DemandForecast, type DemandPoint } from "./quant-engine";

export type CsvRow = Record<string, string>;

export type ParsedDataset = {
  filename: string;
  headers: string[];
  rows: CsvRow[];
};

export type DatasetKey = "sales" | "inventory" | "receivables" | "suppliers" | "purchases" | "cashObligations";
export type CoreDatasetKey = "sales" | "inventory" | "receivables" | "suppliers";
export type AnalysisDatasets = Record<CoreDatasetKey, ParsedDataset> & Partial<Pick<Record<DatasetKey, ParsedDataset>, "purchases" | "cashObligations">>;

export type CashRunwayWeek = {
  week: number;
  label: string;
  expectedInflows: number;
  conservativeInflows: number;
  committedOutflows: number;
  proposedPurchases: number;
  expectedBalance: number;
  conservativeBalance: number;
  driver: string;
};

export type CashRunway = {
  asOfDate: string;
  status: "Safe" | "Watch" | "At risk";
  confidence: "High" | "Medium" | "Low";
  weeks: CashRunwayWeek[];
  minimumExpectedBalance: number;
  minimumConservativeBalance: number;
  shortageWeek: number | null;
  shortageDate: string | null;
  cashGap: number;
  totalExpectedInflows: number;
  totalCommittedOutflows: number;
  assumptions: string[];
  inputs: {
    receivables: Array<{ label: string; amount: number; expectedDate: string; probability: number }>;
    obligations: Array<{ label: string; amount: number; date: string }>;
  };
};

export type AnalysisAction = {
  id: string;
  type: "reorder" | "collection" | "defer" | "cost_control";
  title: string;
  subtitle: string;
  urgency: "Critical" | "High" | "Medium";
  confidence: number;
  amount: number;
  impact: string;
  reason: string;
  evidence: string[];
  meta?: Record<string, string | number | boolean>;
};

export type AnomalyFinding = {
  id: string;
  detectionSource: "ml" | "deterministic";
  detector: string;
  category: "sales" | "pricing" | "returns" | "inventory" | "receivables" | "data";
  severity: "Critical" | "High" | "Medium";
  title: string;
  summary: string;
  actual: string;
  expected: string;
  whyFlagged: string;
  evidence: string[];
  recommendedCheck: string;
  confidence: number;
};

export type UploadAnalysis = {
  actions: AnalysisAction[];
  quality: {
    analysisReady: boolean;
    validRows: number;
    rejectedRows: number;
    duplicates: number;
    coverage: number;
    matchedSkus: number;
    missingLeadTimes: string[];
    unknownSkus: string[];
    warnings: string[];
    criticalErrors: string[];
  };
  summary: {
    availableCash: number;
    reserve: number;
    purchasingCapacity: number;
    overdueReceivables: number;
  };
  agents: { inventory: string; cashflow: string; sales: string; moderator: string };
  anomalies: {
    findings: AnomalyFinding[];
    scannedRows: number;
    reportDate: string;
  };
  quant: {
    engine: "quant-v2";
    modelVersion: "argus-quant-v2";
    demandModelCoverage: number;
    reliableDemandModelCoverage: number;
    averageDemandWape: number | null;
    medianDemandWape: number | null;
    demandModels: Record<string, DemandForecast>;
    demandAnomalies: Record<string, DemandAnomalyPrediction>;
    costIntelligence: CostIntelligenceReport;
  };
  reorder: {
    sku: string;
    requiredUnits: number;
    approvedUnits: number;
    unitCost: number;
    leadTime: number;
    packageSize: number;
    moq: number;
    forecastDaily: number;
    availableStock: number;
  };
  cashRunway: CashRunway;
};

const requiredColumns: Record<DatasetKey, string[]> = {
  sales: ["date", "invoice_id", "customer_id", "sku", "quantity", "selling_price"],
  inventory: ["sku", "current_stock", "purchase_cost", "supplier_id"],
  receivables: ["customer_id", "invoice_id", "due_date", "invoice_amount", "outstanding_amount"],
  suppliers: ["supplier_id", "sku", "average_lead_time_days"],
  purchases: ["purchase_id", "supplier_id", "sku", "order_date", "quantity", "unit_cost"],
  cashObligations: ["date", "label", "amount"],
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}

export async function parseCsvFile(file: File, key: DatasetKey): Promise<ParsedDataset> {
  if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Please upload a CSV file.");
  const matrix = parseCsv(await file.text());
  if (matrix.length < 2) throw new Error("The CSV has no data rows.");
  const headers = matrix[0].map((header) => header.trim().toLowerCase());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length) throw new Error(`Duplicate columns: ${[...new Set(duplicateHeaders)].join(", ")}`);
  const missing = requiredColumns[key].filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`);
  const rows = matrix.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  return { filename: file.name, headers, rows };
}

export function normalizeSku(value: string | undefined): string {
  return String(value ?? "").trim().toUpperCase().replace(/[\s/_]+/g, "-").replace(/-+/g, "-");
}

export function parseNumeric(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const original = String(value ?? "").trim();
  if (!original || /^(null|n\/a|na|none|-)$/i.test(original)) return undefined;
  const negative = /^\(.*\)$/.test(original);
  const match = original.replace(/[₹,%]/g, "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -Math.abs(parsed) : parsed;
}

export function parseBusinessDate(value: string | undefined): Date | undefined {
  const source = String(value ?? "").trim();
  if (!source) return undefined;
  const iso = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return safeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const separated = source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (separated) {
    const first = Number(separated[1]);
    const second = Number(separated[2]);
    const year = Number(separated[3]) < 100 ? 2000 + Number(separated[3]) : Number(separated[3]);
    // Indian exports are normally day-first; values that can only be month-first are handled safely.
    const day = second > 12 && first <= 12 ? second : first;
    const month = second > 12 && first <= 12 ? first : second;
    return safeDate(year, month, day);
  }
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? undefined : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function safeDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

const numberOr = (value: string | undefined, fallback = 0) => parseNumeric(value) ?? fallback;
const truthy = (value: string | undefined) => ["true", "yes", "y", "1", "strategic"].includes(String(value ?? "").trim().toLowerCase());
const roundPackage = (quantity: number, packageSize: number, minimum: number) => quantity <= 0 ? 0 : Math.max(minimum, Math.ceil(quantity / packageSize) * packageSize);
const daysBetween = (later: Date, earlier: Date) => Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const severityOrder = { Critical: 3, High: 2, Medium: 1 } as const;

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export function projectCashRunway(input: {
  asOfDate: string;
  availableCash: number;
  reserve: number;
  receivables: Array<{ label: string; amount: number; expectedDate: string; probability: number }>;
  obligations: Array<{ label: string; amount: number; date: string }>;
  proposedPurchase?: number;
  paymentDelayDays?: number;
  obligationsProvided?: boolean;
}): CashRunway {
  const start = parseBusinessDate(input.asOfDate) ?? new Date();
  const weeks = Array.from({ length: 13 }, (_, index) => {
    const from = addDays(start, index * 7);
    const to = addDays(from, 6);
    return {
      week: index + 1,
      label: `${from.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}-${to.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}`,
      expectedInflows: 0,
      conservativeInflows: 0,
      committedOutflows: 0,
      proposedPurchases: index === 0 ? Math.max(0, input.proposedPurchase ?? 0) : 0,
      expectedBalance: 0,
      conservativeBalance: 0,
      driver: "No major movement",
    };
  });
  const paymentDelay = Math.max(0, Math.round(input.paymentDelayDays ?? 0));
  for (const item of input.receivables) {
    const originalDate = parseBusinessDate(item.expectedDate);
    if (!originalDate || item.amount <= 0 || item.probability <= 0) continue;
    const expectedDate = addDays(originalDate < start ? start : originalDate, paymentDelay);
    const weekIndex = Math.floor(daysBetween(expectedDate, start) / 7);
    if (weekIndex < 0 || weekIndex >= weeks.length) continue;
    const probability = Math.max(0, Math.min(1, item.probability));
    weeks[weekIndex].expectedInflows += item.amount * probability;
    weeks[weekIndex].conservativeInflows += item.amount * Math.max(0, probability - .25);
  }
  for (const item of input.obligations) {
    const date = parseBusinessDate(item.date);
    if (!date || item.amount <= 0) continue;
    const weekIndex = Math.floor(daysBetween(date < start ? start : date, start) / 7);
    if (weekIndex < 0 || weekIndex >= weeks.length) continue;
    weeks[weekIndex].committedOutflows += item.amount;
  }
  let expectedBalance = Math.max(0, input.availableCash);
  let conservativeBalance = expectedBalance;
  for (const week of weeks) {
    expectedBalance += week.expectedInflows - week.committedOutflows - week.proposedPurchases;
    conservativeBalance += week.conservativeInflows - week.committedOutflows - week.proposedPurchases;
    week.expectedBalance = Math.round(expectedBalance);
    week.conservativeBalance = Math.round(conservativeBalance);
    const inflow = week.expectedInflows;
    const outflow = week.committedOutflows + week.proposedPurchases;
    week.expectedInflows = Math.round(week.expectedInflows);
    week.conservativeInflows = Math.round(week.conservativeInflows);
    week.committedOutflows = Math.round(week.committedOutflows);
    week.proposedPurchases = Math.round(week.proposedPurchases);
    week.driver = outflow > inflow && outflow > 0 ? `Outflows exceed expected receipts by INR ${Math.round(outflow - inflow).toLocaleString("en-IN")}` : inflow > outflow ? `Expected receipts add INR ${Math.round(inflow - outflow).toLocaleString("en-IN")}` : "No major net cash movement";
  }
  const minimumExpectedBalance = Math.min(...weeks.map((week) => week.expectedBalance));
  const minimumConservativeBalance = Math.min(...weeks.map((week) => week.conservativeBalance));
  const shortage = weeks.find((week) => week.conservativeBalance < input.reserve);
  const confidence: CashRunway["confidence"] = input.obligationsProvided && input.receivables.length && input.receivables.every((item) => item.probability >= .9) ? "High" : input.obligationsProvided && input.receivables.length ? "Medium" : "Low";
  const cashGap = Math.max(0, Math.round(input.reserve - minimumConservativeBalance));
  return {
    asOfDate: isoDate(start),
    status: cashGap > 0 ? "At risk" : minimumConservativeBalance < input.reserve * 1.2 ? "Watch" : "Safe",
    confidence,
    weeks,
    minimumExpectedBalance,
    minimumConservativeBalance,
    shortageWeek: shortage?.week ?? null,
    shortageDate: shortage ? isoDate(addDays(start, (shortage.week - 1) * 7)) : null,
    cashGap,
    totalExpectedInflows: Math.round(weeks.reduce((sum, week) => sum + week.expectedInflows, 0)),
    totalCommittedOutflows: Math.round(weeks.reduce((sum, week) => sum + week.committedOutflows + week.proposedPurchases, 0)),
    assumptions: [
      "Expected receipts are probability-weighted; they are not treated as guaranteed cash.",
      "The conservative balance reduces each receipt probability by 25 percentage points.",
      input.obligationsProvided ? "Uploaded obligations are treated as committed outflows on their stated dates." : "No cash-obligation file was uploaded, so rent, salaries, tax, EMI and other commitments may be missing.",
    ],
    inputs: { receivables: input.receivables, obligations: input.obligations },
  };
}

export function simulateReorder(input: {
  availableCash: number;
  budget: number;
  reserve: number;
  requiredUnits: number;
  unitCost: number;
  packageSize: number;
  moq: number;
  leadTime: number;
  baseLeadTime: number;
  demandMultiplier: number;
}) {
  const packageSize = Math.max(1, input.packageSize);
  const moq = Math.max(packageSize, input.moq);
  const adjustedNeed = roundPackage(input.requiredUnits * Math.max(.1, input.demandMultiplier) * Math.max(1, input.leadTime) / Math.max(1, input.baseLeadTime), packageSize, moq);
  const spendable = Math.max(0, Math.min(input.budget, input.availableCash - input.reserve));
  const affordablePackages = input.unitCost > 0 ? Math.floor(spendable / (input.unitCost * packageSize)) : 0;
  let approvedUnits = Math.min(adjustedNeed, affordablePackages * packageSize);
  if (approvedUnits > 0 && approvedUnits < moq) approvedUnits = 0;
  return { requiredUnits: adjustedNeed, approvedUnits, deferredUnits: Math.max(0, adjustedNeed - approvedUnits), spendable };
}

export function analyzeUploads(datasets: AnalysisDatasets, budget: number, reserve: number): UploadAnalysis {
  const uniqueRows = (rows: CsvRow[]) => {
    const seen = new Set<string>();
    return rows.filter((row) => { const key = JSON.stringify(row); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const rawSales = uniqueRows(datasets.sales.rows);
  const rawInventory = uniqueRows(datasets.inventory.rows);
  const rawReceivables = uniqueRows(datasets.receivables.rows);
  const rawSuppliers = uniqueRows(datasets.suppliers.rows);
  const rawPurchases = uniqueRows(datasets.purchases?.rows ?? []);
  const rawCashObligations = uniqueRows(datasets.cashObligations?.rows ?? []);
  const duplicateCount = Object.values(datasets).reduce((sum, dataset) => {
    const fingerprints = dataset.rows.map((row) => JSON.stringify(row));
    return sum + fingerprints.length - new Set(fingerprints).size;
  }, 0);

  let rejectedRows = 0;
  let invalidDateCount = 0;
  let invalidNumberCount = 0;
  let suspiciousValueCount = 0;
  const sales = rawSales.filter((row) => {
    const validDate = parseBusinessDate(row.date);
    const quantity = parseNumeric(row.quantity);
    const price = parseNumeric(row.selling_price);
    const plausible = quantity !== undefined && quantity <= 100_000 && price !== undefined && price <= 10_000_000;
    const valid = Boolean(normalizeSku(row.sku) && validDate && quantity !== undefined && quantity > 0 && price !== undefined && price >= 0 && plausible);
    if (!plausible && quantity !== undefined && price !== undefined) suspiciousValueCount += 1;
    if (!valid) { rejectedRows += 1; if (!validDate) invalidDateCount += 1; if (quantity === undefined || price === undefined) invalidNumberCount += 1; }
    return valid;
  });
  const inventory = rawInventory.filter((row) => {
    const stock = parseNumeric(row.current_stock);
    const cost = parseNumeric(row.purchase_cost);
    const plausible = stock !== undefined && stock >= 0 && stock <= 10_000_000 && cost !== undefined && cost <= 10_000_000;
    const valid = Boolean(normalizeSku(row.sku) && stock !== undefined && cost !== undefined && cost > 0 && plausible);
    if (!plausible && stock !== undefined && cost !== undefined) suspiciousValueCount += 1;
    if (!valid) { rejectedRows += 1; if (stock === undefined || cost === undefined) invalidNumberCount += 1; }
    return valid;
  });
  const suppliers = rawSuppliers.filter((row) => {
    const valid = Boolean(normalizeSku(row.sku) && String(row.supplier_id ?? "").trim());
    if (!valid) rejectedRows += 1;
    return valid;
  });
  const purchases = rawPurchases.filter((row) => {
    const date = parseBusinessDate(row.receipt_date || row.order_date);
    const quantity = parseNumeric(row.quantity);
    const cost = parseNumeric(row.landed_unit_cost || row.unit_cost);
    const valid = Boolean(date && normalizeSku(row.sku) && String(row.supplier_id ?? "").trim() && String(row.purchase_id ?? "").trim() && quantity && quantity > 0 && cost && cost > 0);
    if (!valid) { rejectedRows += 1; if (!date) invalidDateCount += 1; if (quantity === undefined || cost === undefined) invalidNumberCount += 1; }
    return valid;
  });
  const receivables = rawReceivables.filter((row) => {
    const amount = parseNumeric(row.outstanding_amount);
    const invoiceAmount = parseNumeric(row.invoice_amount);
    const plausible = amount !== undefined && amount >= 0 && amount <= 10_000_000 && (invoiceAmount === undefined || invoiceAmount <= 0 || amount <= invoiceAmount * 1.01);
    const valid = Boolean(String(row.customer_id ?? "").trim() && String(row.invoice_id ?? "").trim() && amount !== undefined && plausible);
    if (!plausible && amount !== undefined) suspiciousValueCount += 1;
    if (!valid) { rejectedRows += 1; if (amount === undefined) invalidNumberCount += 1; }
    return valid;
  });
  const cashObligations = rawCashObligations.filter((row) => {
    const date = parseBusinessDate(row.date);
    const amount = parseNumeric(row.amount);
    const valid = Boolean(date && String(row.label ?? "").trim() && amount !== undefined && amount > 0 && amount <= 10_000_000);
    if (!valid) { rejectedRows += 1; if (!date) invalidDateCount += 1; if (amount === undefined) invalidNumberCount += 1; }
    return valid;
  });

  const criticalErrors: string[] = [];
  if (!sales.length) criticalErrors.push("No usable sales rows remain after validation.");
  if (!inventory.length) criticalErrors.push("No usable inventory rows contain SKU, current stock and purchase cost.");
  if (!Number.isFinite(budget) || budget < 0 || !Number.isFinite(reserve) || reserve < 0) criticalErrors.push("Purchase budget and cash reserve must be valid non-negative amounts.");

  const inventorySkus = new Set(inventory.map((row) => normalizeSku(row.sku)));
  const salesSkus = new Set(sales.map((row) => normalizeSku(row.sku)));
  const supplierBySku = new Map<string, CsvRow>();
  for (const row of suppliers) {
    const key = normalizeSku(row.sku);
    if (!supplierBySku.has(key) || parseNumeric(row.average_lead_time_days) !== undefined) supplierBySku.set(key, row);
  }
  const unknownSkus = [...salesSkus].filter((sku) => !inventorySkus.has(sku));
  const missingLeadTimes = [...inventorySkus].filter((sku) => (parseNumeric(supplierBySku.get(sku)?.average_lead_time_days) ?? 0) <= 0);
  const matchedSkus = [...salesSkus].filter((sku) => inventorySkus.has(sku)).length;
  const coverage = salesSkus.size ? Math.round(matchedSkus / salesSkus.size * 100) : 0;
  if (sales.length && inventory.length && matchedSkus === 0) criticalErrors.push("No normalized sales SKU matches the inventory file, so demand cannot be connected to stock.");

  const salesBySku = new Map<string, CsvRow[]>();
  for (const row of sales) {
    const key = normalizeSku(row.sku);
    salesBySku.set(key, [...(salesBySku.get(key) ?? []), row]);
  }
  const demandModels: Record<string, DemandForecast> = {};
  const demandAnomalies: Record<string, DemandAnomalyPrediction> = {};
  for (const [sku, rows] of salesBySku) {
    const points: DemandPoint[] = rows.flatMap((row) => {
      const date = parseBusinessDate(row.date);
      if (!date) return [];
      return [{ date: isoDate(date), quantity: Math.max(0, numberOr(row.quantity) - numberOr(row.return_quantity)) }];
    });
    demandModels[sku] = forecastDemand(points);
    demandAnomalies[sku] = detectDemandAnomaly(points);
  }
  const metricRows = inventory.map((stock) => {
    const normalizedSku = normalizeSku(stock.sku);
    const skuSales = (salesBySku.get(normalizedSku) ?? []).sort((a, b) => (parseBusinessDate(a.date)?.getTime() ?? 0) - (parseBusinessDate(b.date)?.getTime() ?? 0));
    const maxDate = skuSales.length ? parseBusinessDate(skuSales[skuSales.length - 1].date)! : new Date();
    const recentStart = new Date(maxDate); recentStart.setDate(maxDate.getDate() - 13);
    const priorStart = new Date(maxDate); priorStart.setDate(maxDate.getDate() - 41);
    const netQuantity = (row: CsvRow) => Math.max(0, numberOr(row.quantity) - numberOr(row.return_quantity));
    const recentQty = skuSales.filter((row) => (parseBusinessDate(row.date)?.getTime() ?? 0) >= recentStart.getTime()).reduce((sum, row) => sum + netQuantity(row), 0);
    const priorQty = skuSales.filter((row) => { const date = parseBusinessDate(row.date); return Boolean(date && date >= priorStart && date < recentStart); }).reduce((sum, row) => sum + netQuantity(row), 0);
    const recentDaily = recentQty / 14;
    const priorDaily = priorQty / 28;
    const demandForecast = demandModels[normalizedSku];
    const forecastDaily = Math.max(0.05, demandForecast?.forecastDaily ?? recentDaily * .68 + priorDaily * .32);
    const available = numberOr(stock.current_stock) - numberOr(stock.reserved_stock) + numberOr(stock.incoming_stock);
    const supplier = supplierBySku.get(normalizedSku);
    const explicitLeadTime = parseNumeric(supplier?.average_lead_time_days);
    const leadTime = Math.max(1, explicitLeadTime ?? 7);
    const safety = forecastDaily * 3;
    const shortage = Math.max(0, forecastDaily * leadTime + safety - available);
    const packageSize = Math.max(1, numberOr(stock.package_size, numberOr(supplier?.package_size, 1)));
    const moq = Math.max(packageSize, numberOr(stock.minimum_order_quantity, numberOr(supplier?.minimum_order_quantity, packageSize)));
    const required = roundPackage(shortage, packageSize, moq);
    const unitCost = numberOr(stock.purchase_cost);
    const averagePrice = skuSales.length ? skuSales.reduce((sum, row) => sum + numberOr(row.selling_price), 0) / skuSales.length : unitCost * 1.35;
    const daysCover = available / forecastDaily;
    const trend = priorDaily > 0 ? (recentDaily - priorDaily) / priorDaily : recentDaily > 0 ? 1 : 0;
    const urgency = daysCover < leadTime ? 3 : daysCover < leadTime + 5 ? 2 : 1;
    return { sku: normalizedSku, name: stock.product_name || normalizedSku, category: stock.category || "Uncategorised", available, current: numberOr(stock.current_stock), unitCost, averagePrice, leadTime, forecastDaily, forecast14: demandForecast?.forecast14 ?? forecastDaily * 14, forecast30: demandForecast?.forecast30 ?? forecastDaily * 30, demandModel: demandForecast?.model ?? "moving_average", demandConfidence: demandForecast?.confidence ?? "Low", demandWape: demandForecast?.wape ?? null, recentDaily, priorDaily, trend, daysCover, required, packageSize, moq, urgency, supplier: supplier?.supplier_name || stock.supplier_id, supplierId: supplier?.supplier_id || stock.supplier_id, leadTimeAssumed: explicitLeadTime === undefined };
  });

  const metricBySku = new Map(metricRows.map((item) => [item.sku, item]));
  const supplierCostFallback = suppliers.flatMap((supplier) => {
    const sku = normalizeSku(supplier.sku);
    const item = metricBySku.get(sku);
    const quotedCost = parseNumeric(supplier.last_purchase_price);
    if (!item || !quotedCost || quotedCost <= 0) return [];
    const rawOnTime = parseNumeric(supplier.on_time_rate) ?? .75;
    return [{
      sku,
      productName: item.name,
      category: item.category,
      supplierId: String(supplier.supplier_id || "unknown"),
      supplierName: String(supplier.supplier_name || supplier.supplier_id || "Unknown supplier"),
      currentCost: item.unitCost,
      quotedCost,
      sellingPrice: item.averagePrice,
      forecast30: item.forecast30,
      leadTime: Math.max(1, parseNumeric(supplier.average_lead_time_days) ?? item.leadTime),
      moq: Math.max(1, parseNumeric(supplier.minimum_order_quantity) ?? item.moq),
      packageSize: Math.max(1, parseNumeric(supplier.package_size) ?? item.packageSize),
      qualityRating: parseNumeric(supplier.quality_rating) ?? 3.5,
      onTimeRate: rawOnTime > 1 ? rawOnTime / 100 : rawOnTime,
      alternativeEligible: true,
    }];
  });
  const purchaseCosts = purchases.flatMap((purchase) => {
    const sku = normalizeSku(purchase.sku);
    const item = metricBySku.get(sku);
    if (!item) return [];
    const supplier = suppliers.find((candidate) => normalizeSku(candidate.sku) === sku && candidate.supplier_id === purchase.supplier_id);
    const quantity = Math.max(1, numberOr(purchase.quantity));
    const baseCost = numberOr(purchase.unit_cost);
    const landedCost = parseNumeric(purchase.landed_unit_cost) ?? baseCost + numberOr(purchase.freight) / quantity + numberOr(purchase.tax) / quantity;
    return [{ sku, productName: item.name, category: item.category, supplierId: String(purchase.supplier_id), supplierName: String(supplier?.supplier_name || purchase.supplier_id), currentCost: item.unitCost, quotedCost: landedCost, sellingPrice: item.averagePrice, forecast30: item.forecast30, leadTime: Math.max(1, numberOr(supplier?.average_lead_time_days, item.leadTime)), moq: Math.max(1, numberOr(supplier?.minimum_order_quantity, item.moq)), packageSize: Math.max(1, numberOr(supplier?.package_size, item.packageSize)), qualityRating: numberOr(supplier?.quality_rating, 3.5), onTimeRate: Math.min(1, numberOr(supplier?.on_time_rate, .75)), observedAt: isoDate(parseBusinessDate(purchase.receipt_date || purchase.order_date)!), quantity, paymentTermDays: numberOr(purchase.payment_term_days), freightPerUnit: numberOr(purchase.freight) / quantity, taxPerUnit: numberOr(purchase.tax) / quantity, alternativeEligible: String(purchase.eligible_alternative ?? "true").toLowerCase() !== "false" }];
  });
  const costIntelligence = analyzeCosts(purchaseCosts.length ? purchaseCosts : supplierCostFallback, Math.max(2_000, budget * .02));

  const validSalesDates = sales.map((row) => parseBusinessDate(row.date)).filter((date): date is Date => Boolean(date));
  const analysisDate = validSalesDates.length ? new Date(Math.max(...validSalesDates.map((date) => date.getTime()))) : new Date();
  let invalidDueDates = 0;
  const timedReceivables = receivables.map((row) => {
    const dueDate = parseBusinessDate(row.due_date);
    const promisedDate = parseBusinessDate(row.expected_payment_date || row.promised_payment_date);
    if (!dueDate) invalidDueDates += 1;
    const amount = Math.max(0, numberOr(row.outstanding_amount));
    const overdueDays = dueDate ? daysBetween(analysisDate, dueDate) : 0;
    const strategic = truthy(row.strategic_flag) || String(row.relationship_type).toLowerCase() === "strategic";
    const disputed = truthy(row.dispute_flag);
    const expectedDate = promisedDate ?? (dueDate && dueDate > analysisDate ? dueDate : addDays(analysisDate, strategic ? 7 : 10));
    const probability = disputed ? 0 : promisedDate ? .95 : overdueDays > 0 ? .55 : .75;
    return { ...row, amount, overdueDays, strategic, disputed, dueDate, expectedDate, probability };
  });
  const runwayReceivables = timedReceivables.filter((row) => row.amount > 0 && row.dueDate).map((row) => ({
    label: `${row.customer_name || row.customer_id} - ${row.invoice_id}`,
    amount: row.amount,
    expectedDate: isoDate(row.expectedDate),
    probability: row.probability,
  }));
  const runwayObligations = cashObligations.map((row) => ({ label: row.label, amount: Math.max(0, numberOr(row.amount)), date: isoDate(parseBusinessDate(row.date)!) }));
  const availableCash = Math.max(0, budget + reserve);
  const prePurchaseRunway = projectCashRunway({
    asOfDate: isoDate(analysisDate), availableCash, reserve, receivables: runwayReceivables, obligations: runwayObligations, obligationsProvided: Boolean(datasets.cashObligations),
  });
  const fourWeekHeadroom = Math.max(0, Math.min(...prePurchaseRunway.weeks.slice(0, 4).map((week) => week.conservativeBalance)) - reserve);
  const purchasingCapacity = Math.max(0, Math.min(budget, fourWeekHeadroom));
  let remaining = purchasingCapacity;
  const allocations = [...metricRows].sort((a, b) => (b.urgency * b.required * Math.max(1, b.averagePrice - b.unitCost)) - (a.urgency * a.required * Math.max(1, a.averagePrice - a.unitCost))).map((item) => {
    const packages = item.unitCost > 0 ? Math.floor(remaining / (item.unitCost * item.packageSize)) : 0;
    let approved = Math.min(item.required, packages * item.packageSize);
    if (approved > 0 && approved < item.moq) approved = 0;
    remaining -= approved * item.unitCost;
    return { ...item, approved };
  });
  const reorder = allocations.find((item) => item.required > 0 && item.approved > 0) ?? allocations.find((item) => item.required > 0) ?? allocations[0];
  const excessScore = (item: typeof metricRows[number]) => Math.max(0, item.available - item.forecastDaily * 45) * item.unitCost * (item.trend < 0 ? 1 + Math.abs(item.trend) : .7);
  const excess = [...metricRows].sort((a, b) => excessScore(b) - excessScore(a))[0];

  const overdue = timedReceivables.filter((row) => row.amount > 0 && row.overdueDays > 0).sort((a, b) => Number(b.strategic) - Number(a.strategic) || Number(a.disputed) - Number(b.disputed) || b.amount - a.amount || b.overdueDays - a.overdueDays);
  const outstanding = timedReceivables.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount);
  const collection = overdue[0] ?? outstanding[0];
  const overdueTotal = overdue.reduce((sum, row) => sum + row.amount, 0);
  const cashRunway = projectCashRunway({
    asOfDate: isoDate(analysisDate), availableCash, reserve, receivables: runwayReceivables, obligations: runwayObligations,
    proposedPurchase: (reorder?.approved ?? 0) * (reorder?.unitCost ?? 0), obligationsProvided: Boolean(datasets.cashObligations),
  });

  const anomalyFindings: AnomalyFinding[] = [];
  if (duplicateCount) anomalyFindings.push({
    id: "data-duplicates", detectionSource: "deterministic", detector: "Exact-row duplicate validation", category: "data", severity: duplicateCount > 100 ? "High" : "Medium",
    title: "Repeated records found", summary: `${duplicateCount} exact duplicate row${duplicateCount === 1 ? " was" : "s were"} excluded before calculations.`,
    actual: `${duplicateCount} duplicates`, expected: "No repeated exports",
    whyFlagged: "Counting the same invoice, stock row or receivable twice would distort demand and cash calculations.",
    evidence: ["Exact full-row fingerprints matched", "Duplicates were removed before forecasting"],
    recommendedCheck: "Confirm that overlapping export periods or repeated file merges caused these duplicates.", confidence: 99,
  });
  for (const finding of costIntelligence.findings) anomalyFindings.push({
    id: finding.id,
    detectionSource: "ml",
    detector: costIntelligence.model,
    category: "pricing",
    severity: finding.changePercent >= 20 || finding.marginAtRisk30 >= Math.max(25_000, budget * .25) ? "High" : "Medium",
    title: `Cost pressure detected for ${finding.productName}`,
    summary: `${finding.supplierName} is ${Math.round(finding.changePercent)}% above the Quant Engine's expected cost, with approximately ₹${Math.round(finding.marginAtRisk30).toLocaleString("en-IN")} of estimated 30-day margin exposure.`,
    actual: `₹${Math.round(finding.actualCost).toLocaleString("en-IN")}/unit`,
    expected: `₹${Math.round(finding.expectedLower).toLocaleString("en-IN")}–₹${Math.round(finding.expectedUpper).toLocaleString("en-IN")}/unit`,
    whyFlagged: finding.likelyDriver,
    evidence: finding.evidence,
    recommendedCheck: finding.alternativeSupplier ? `Compare ${finding.alternativeSupplier.supplierName} before approving the purchase; its recorded quote is ${Math.round(finding.alternativeSupplier.savingPercent)}% lower.` : "Verify the supplier quote and business context before approving or repricing the product.",
    confidence: finding.confidence,
  });
  for (const item of metricRows) {
    const skuRows = salesBySku.get(item.sku) ?? [];
    if (skuRows.length >= 28 && item.priorDaily > 0 && (item.trend >= .35 || item.trend <= -.2)) {
      const rising = item.trend > 0;
      const change = Math.round(Math.abs(item.trend) * 100);
      anomalyFindings.push({
        id: `trend-${item.sku}`, detectionSource: "deterministic", detector: "14-day versus 28-day demand trend rule", category: "sales", severity: rising && item.daysCover < item.leadTime ? "High" : "Medium",
        title: `${item.name} demand ${rising ? "increased" : "declined"} unusually`,
        summary: `Recent daily demand is ${change}% ${rising ? "above" : "below"} the prior four-week baseline.`,
        actual: `${item.recentDaily.toFixed(1)} units/day`, expected: `${item.priorDaily.toFixed(1)} units/day baseline`,
        whyFlagged: `The recent 14-day rate moved beyond Argus's ${rising ? "35% growth" : "20% decline"} verification threshold.`,
        evidence: [`SKU: ${item.sku}`, `Recent 14-day rate: ${item.recentDaily.toFixed(1)} units/day`, `Prior 28-day rate: ${item.priorDaily.toFixed(1)} units/day`, `${Math.max(0, item.daysCover).toFixed(0)} days of stock cover`],
        recommendedCheck: rising ? "Confirm whether this is recurring demand, a promotion or a one-time bulk order before increasing the forecast." : "Check for lost customers, stockouts, seasonality or a product substitution before pausing purchases.",
        confidence: skuRows.length >= 60 ? 90 : 80,
      });
    }
    const prediction = demandAnomalies[item.sku];
    if (prediction?.status === "detected") {
      const spike = prediction.actual > prediction.expected;
      anomalyFindings.push({
        id: `predicted-demand-${item.sku}-${prediction.date}`, detectionSource: "ml", detector: `${prediction.model.replaceAll("_", " ")} forecast-residual model`, category: "sales", severity: spike && item.daysCover < item.leadTime ? "High" : "Medium",
        title: `${spike ? "Predicted demand spike" : "Predicted demand drop"} for ${item.name}`,
        summary: `${prediction.actual.toFixed(0)} units were recorded on ${prediction.date}; the backtested ${prediction.model.replaceAll("_", " ")} model expected approximately ${prediction.expected.toFixed(1)} units.`,
        actual: `${prediction.actual.toFixed(0)} units`, expected: `${prediction.lower.toFixed(0)}–${prediction.upper.toFixed(0)} units`,
        whyFlagged: prediction.reason,
        evidence: [`Date: ${prediction.date}`, `SKU: ${item.sku}`, `Selected model: ${prediction.model.replaceAll("_", " ")}`, `Rolling backtest WAPE: ${((prediction.wape ?? 0) * 100).toFixed(1)}%`, `Residual anomaly score: ${(prediction.residualScore ?? 0).toFixed(1)}`],
        recommendedCheck: spike ? "Verify whether a promotion, seasonal event or exceptional order caused the spike before treating it as recurring demand." : "Verify stock availability, lost sales, cancellations and missing entries before lowering the demand plan.",
        confidence: prediction.confidence,
      });
    }
    const totalQuantity = skuRows.reduce((sum, row) => sum + Math.max(0, numberOr(row.quantity)), 0);
    const totalReturns = skuRows.reduce((sum, row) => sum + Math.max(0, numberOr(row.return_quantity)), 0);
    if (totalQuantity > 0 && totalReturns / totalQuantity > .12) anomalyFindings.push({
      id: `returns-${item.sku}`, detectionSource: "deterministic", detector: "Verified return-rate threshold", category: "returns", severity: totalReturns / totalQuantity > .25 ? "High" : "Medium",
      title: `Unusually high returns for ${item.name}`, summary: `${Math.round(totalReturns / totalQuantity * 100)}% of reported units were returned.`,
      actual: `${totalReturns.toFixed(0)} returned units`, expected: "Return rate below 12%",
      whyFlagged: "High returns can make recorded sales look stronger than net demand and may indicate quality or fulfilment problems.",
      evidence: [`SKU: ${item.sku}`, `Reported quantity: ${totalQuantity.toFixed(0)}`, `Returned quantity: ${totalReturns.toFixed(0)}`],
      recommendedCheck: "Review return reasons and ensure the forecast uses net fulfilled demand.", confidence: 92,
    });
    const supplier = supplierBySku.get(item.sku);
    const lastPrice = parseNumeric(supplier?.last_purchase_price);
    if (lastPrice && item.unitCost > lastPrice * 1.1) anomalyFindings.push({
      id: `price-${item.sku}`, detectionSource: "deterministic", detector: "Current-versus-last-price rule", category: "pricing", severity: item.unitCost > lastPrice * 1.25 ? "High" : "Medium",
      title: `Purchase price increased for ${item.name}`, summary: `Current cost is ${Math.round((item.unitCost / lastPrice - 1) * 100)}% above the supplier's last recorded price.`,
      actual: `₹${item.unitCost.toLocaleString("en-IN")}`, expected: `Last price ₹${lastPrice.toLocaleString("en-IN")}`,
      whyFlagged: "A material cost increase changes margin and may change which SKU should receive limited purchasing cash.",
      evidence: [`Supplier: ${item.supplier}`, `SKU: ${item.sku}`, `Difference: ₹${(item.unitCost - lastPrice).toLocaleString("en-IN")}/unit`],
      recommendedCheck: "Confirm the supplier quote and compare alternate suppliers before approving the order.", confidence: 95,
    });
    if (item.available < 0) anomalyFindings.push({
      id: `stock-${item.sku}`, detectionSource: "deterministic", detector: "Available-stock reconciliation rule", category: "inventory", severity: "Critical",
      title: `Negative usable stock for ${item.name}`, summary: `Reserved stock exceeds current and confirmed incoming stock by ${Math.abs(item.available).toFixed(0)} units.`,
      actual: `${item.available.toFixed(0)} usable units`, expected: "Usable stock of zero or more",
      whyFlagged: "This usually indicates an inventory-sync problem, an unrecorded receipt or excessive reservations.",
      evidence: [`SKU: ${item.sku}`, `Current stock: ${item.current.toFixed(0)}`, `Calculated usable stock: ${item.available.toFixed(0)}`],
      recommendedCheck: "Perform a stock count and reconcile reserved and incoming quantities before ordering.", confidence: 99,
    });
  }
  const overdueAmounts = overdue.map((row) => row.amount);
  const typicalOverdueAmount = median(overdueAmounts);
  for (const row of overdue.slice(0, 5)) {
    if (row.overdueDays > 30 || (row.overdueDays > 14 && row.amount > typicalOverdueAmount * 1.5)) anomalyFindings.push({
      id: `payment-${row.invoice_id}`, detectionSource: "deterministic", detector: "Payment-delay prioritization rule", category: "receivables", severity: row.disputed ? "High" : "Medium",
      title: `Unusual payment delay from ${row.customer_name || row.customer_id}`, summary: `Invoice ${row.invoice_id} is ₹${row.amount.toLocaleString("en-IN")} outstanding and ${row.overdueDays} days overdue.`,
      actual: `${row.overdueDays} days overdue`, expected: "Payment by the uploaded due date",
      whyFlagged: "The delay or amount is materially above the current overdue portfolio and could restrict purchasing cash.",
      evidence: [`Invoice: ${row.invoice_id}`, `Outstanding: ₹${row.amount.toLocaleString("en-IN")}`, `Strategic customer: ${row.strategic ? "Yes" : "No"}`, `Dispute: ${row.disputed ? "Yes" : "No"}`],
      recommendedCheck: row.disputed || row.strategic ? "Review the relationship and dispute context personally before choosing a follow-up." : "Confirm a payment date and update the cash scenario with the customer's promise.", confidence: 90,
    });
  }
  const categoryPriority: Record<AnomalyFinding["category"], number> = { pricing: 6, inventory: 5, receivables: 4, returns: 3, sales: 2, data: 1 };
  const anomalies = anomalyFindings.sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity] || categoryPriority[b.category] - categoryPriority[a.category] || b.confidence - a.confidence).slice(0, 12);

  if (!reorder || !excess) criticalErrors.push("Inventory calculations could not produce a recommendation.");
  const safeReorder = reorder ?? { sku: "UNKNOWN", name: "priority stock", available: 0, current: 0, unitCost: 0, averagePrice: 0, leadTime: 7, forecastDaily: 0, forecast14: 0, recentDaily: 0, priorDaily: 0, trend: 0, daysCover: 0, required: 0, packageSize: 1, moq: 1, urgency: 1, supplier: "unknown", leadTimeAssumed: true, approved: 0 };
  const safeExcess = excess ?? safeReorder;
  const reorderImpact = Math.round(Math.min(safeReorder.approved, safeReorder.forecast14) * safeReorder.averagePrice);
  const declinePercent = Math.max(0, Math.round(-safeExcess.trend * 100));
  const excessUnits = Math.max(0, safeExcess.available - safeExcess.forecastDaily * 45);
  const excessValue = Math.round(excessUnits * safeExcess.unitCost);
  const historyLength = salesBySku.get(safeReorder.sku)?.length ?? 0;
  const reorderConfidence = Math.max(55, (historyLength >= 60 ? 90 : historyLength >= 28 ? 80 : 65) - (safeReorder.leadTimeAssumed ? 10 : 0));
  const purchaseTitle = safeReorder.required <= 0 ? "No urgent replenishment needed" : safeReorder.approved > 0 ? `Order ${safeReorder.approved} units of ${safeReorder.name}` : `Hold the ${safeReorder.name} order until cash is available`;
  const actions: AnalysisAction[] = [
    {
      id: `reorder-${safeReorder.sku}`, type: "reorder", title: purchaseTitle,
      subtitle: `${Math.max(0, safeReorder.daysCover).toFixed(0)} days of stock; supplier takes ${safeReorder.leadTime} days`, urgency: safeReorder.daysCover < safeReorder.leadTime ? "Critical" : "High", confidence: reorderConfidence,
      amount: safeReorder.approved * safeReorder.unitCost, impact: safeReorder.required <= 0 ? "Current usable stock covers the verified lead-time requirement" : safeReorder.approved > 0 ? `Protects approximately ₹${reorderImpact.toLocaleString("en-IN")} in forecast sales` : `Avoids breaching the ₹${reserve.toLocaleString("en-IN")} cash reserve`,
      reason: safeReorder.required <= 0 ? `Verified demand and usable stock show no reorder shortage for ${safeReorder.name}.` : `Verified sales imply ${safeReorder.forecast14.toFixed(0)} units of 14-day demand. The four-week conservative cash outlook funds ${safeReorder.approved} of ${safeReorder.required} required units while protecting the entered reserve.`,
      evidence: [`Usable stock: ${safeReorder.available.toFixed(0)} units`, `14-day forecast: ${safeReorder.forecast14.toFixed(0)} units`, `Four-week safe purchasing capacity: ₹${purchasingCapacity.toLocaleString("en-IN")}`, `Supplier lead time: ${safeReorder.leadTime} days${safeReorder.leadTimeAssumed ? " (assumed)" : ""}`],
      meta: { requiredUnits: safeReorder.required, unitCost: safeReorder.unitCost, leadTime: safeReorder.leadTime, sku: safeReorder.sku, packageSize: safeReorder.packageSize, moq: safeReorder.moq, forecastDaily: safeReorder.forecastDaily, availableStock: safeReorder.available },
    },
    {
      id: `collect-${collection?.customer_id || "none"}`, type: "collection", title: collection ? `Confirm payment date with ${collection.customer_name || collection.customer_id}` : "No collection follow-up needed",
      subtitle: collection ? `₹${collection.amount.toLocaleString("en-IN")} ${collection.overdueDays ? `is overdue by ${collection.overdueDays} days` : "is outstanding"}` : "No positive outstanding receivable was found", urgency: (collection?.overdueDays ?? 0) > 7 ? "High" : "Medium", confidence: collection?.overdueDays ? 92 : collection ? 70 : 95,
      amount: collection?.amount || 0, impact: collection ? `Can expand purchasing capacity by ₹${collection.amount.toLocaleString("en-IN")}` : "No collection action is justified by the uploaded rows",
      reason: `${collection ? collection.disputed ? "A dispute is recorded, so Argus requires personal review before any follow-up." : collection.strategic ? "This is a strategic customer, so Argus recommends a relationship-sensitive check-in." : "The uploaded receivables identify this as the highest-priority collection." : "Argus abstains because the verified snapshot has no collectible balance."} No message is sent without owner approval.`,
      evidence: [`Relationship: ${collection?.relationship_type || "not provided"}`, `Outstanding: ₹${(collection?.amount || 0).toLocaleString("en-IN")}`, `Days overdue: ${collection?.overdueDays || 0}`, `Dispute recorded: ${collection?.disputed ? "Yes" : "No"}`],
      meta: { customerName: collection?.customer_name || collection?.customer_id || "customer", strategic: Boolean(collection?.strategic), disputed: Boolean(collection?.disputed), invoiceId: collection?.invoice_id || "" },
    },
    {
      id: `defer-${safeExcess.sku}`, type: "defer", title: excessValue > 0 ? `Pause the next ${safeExcess.name} purchase` : "No excess purchase to pause",
      subtitle: `${Math.max(0, safeExcess.daysCover).toFixed(0)} days of stock cover${declinePercent ? `; sales are down ${declinePercent}%` : ""}`, urgency: "Medium", confidence: (salesBySku.get(safeExcess.sku)?.length ?? 0) >= 28 ? 88 : 68,
      amount: excessValue, impact: excessValue > 0 ? `Keeps approximately ₹${excessValue.toLocaleString("en-IN")} available for faster-moving stock` : "No capital is currently tied up above the stock-cover target",
      reason: excessValue > 0 ? `${safeExcess.name} has the highest excess-stock value in the uploaded inventory. Its recent sales are ${declinePercent ? `${declinePercent}% below` : "not above"} the prior baseline.` : "Argus abstains because no inventory row exceeds the verified 45-day stock target.",
      evidence: [`Current usable stock: ${safeExcess.available.toFixed(0)} units`, `Forecast daily demand: ${safeExcess.forecastDaily.toFixed(1)} units`, `Days of stock cover: ${Math.max(0, safeExcess.daysCover).toFixed(0)}`, `Recent trend: ${(safeExcess.trend * 100).toFixed(0)}%`],
      meta: { sku: safeExcess.sku },
    },
  ];
  const topCostFinding = costIntelligence.findings[0];
  const costMetric = topCostFinding ? metricBySku.get(topCostFinding.sku) : undefined;
  if (topCostFinding && topCostFinding.marginAtRisk30 >= Math.max(2_000, excessValue * .1)) {
    actions[2] = {
      id: topCostFinding.id,
      type: "cost_control",
      title: `Verify ${topCostFinding.productName} cost before ordering`,
      subtitle: `${Math.round(topCostFinding.changePercent)}% above the modelled range; ${topCostFinding.marginErosionPoints.toFixed(1)} margin points at risk`,
      urgency: topCostFinding.marginAtRisk30 >= Math.max(25_000, budget * .25) || topCostFinding.marginErosionPoints >= 5 ? "High" : "Medium",
      confidence: topCostFinding.confidence,
      amount: Math.round(topCostFinding.marginAtRisk30),
      impact: `Reviews approximately ₹${Math.round(topCostFinding.marginAtRisk30).toLocaleString("en-IN")} of estimated 30-day margin exposure`,
      reason: `${topCostFinding.supplierName} quoted ₹${Math.round(topCostFinding.actualCost).toLocaleString("en-IN")}/unit against an expected range of ₹${Math.round(topCostFinding.expectedLower).toLocaleString("en-IN")}–₹${Math.round(topCostFinding.expectedUpper).toLocaleString("en-IN")}. ${topCostFinding.likelyDriver} The owner must verify the context before changing an order or selling price.`,
      evidence: [...topCostFinding.evidence, `Expected gross margin: ${topCostFinding.expectedMarginPercent.toFixed(1)}%`, `Current quoted-cost margin: ${topCostFinding.grossMarginPercent.toFixed(1)}%`, ...(topCostFinding.alternativeSupplier ? [`Eligible comparison: ${topCostFinding.alternativeSupplier.supplierName} at ₹${Math.round(topCostFinding.alternativeSupplier.quotedCost).toLocaleString("en-IN")}/unit`] : [])],
      meta: {
        sku: topCostFinding.sku,
        requiredUnits: costMetric?.required ?? 0,
        unitCost: topCostFinding.actualCost,
        expectedCost: topCostFinding.expectedCost,
        leadTime: costMetric?.leadTime ?? 7,
        packageSize: costMetric?.packageSize ?? 1,
        moq: costMetric?.moq ?? 1,
        forecastDaily: costMetric?.forecastDaily ?? 0,
        availableStock: costMetric?.available ?? 0,
      },
    };
  }

  const warnings = [
    ...(duplicateCount ? [`${duplicateCount} exact duplicate rows were isolated`] : []),
    ...(rejectedRows ? [`${rejectedRows} unusable rows were rejected`] : []),
    ...(invalidDateCount + invalidDueDates ? [`${invalidDateCount + invalidDueDates} rows contain missing or invalid dates`] : []),
    ...(invalidNumberCount ? [`${invalidNumberCount} rows contain missing or invalid numeric values`] : []),
    ...(suspiciousValueCount ? [`${suspiciousValueCount} rows contain implausible values and were quarantined`] : []),
    ...(missingLeadTimes.length ? [`${missingLeadTimes.length} SKUs use the 7-day lead-time assumption`] : []),
    ...(unknownSkus.length ? [`${unknownSkus.length} normalized sales SKUs are missing from inventory`] : []),
    ...(!datasets.cashObligations ? ["Cash-obligation file was not uploaded; the 13-week runway may omit rent, salaries, GST, EMI and supplier commitments"] : []),
    ...(!datasets.purchases ? ["A dated purchase ledger was not uploaded; supplier-cost checks use the lower-confidence last-price fallback."] : []),
    ...(costIntelligence.mode === "fallback" ? ["Cost intelligence used a low-confidence last-price fallback because fewer than 30 usable supplier prices were available"] : []),
    ...(costIntelligence.mode === "unavailable" ? ["Cost intelligence abstained because no usable supplier purchase prices were provided"] : []),
  ];
  const demandWapes = Object.values(demandModels).map((forecast) => forecast.wape).filter((value): value is number => value !== null && Number.isFinite(value));
  const reliableDemandModelCoverage = Object.values(demandAnomalies).filter((prediction) => prediction.status !== "abstained").length;
  const reliableDemandWapes = Object.values(demandAnomalies).filter((prediction) => prediction.status !== "abstained").map((prediction) => prediction.wape).filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    actions,
    quality: { analysisReady: criticalErrors.length === 0, validRows: rawSales.length + rawInventory.length + rawReceivables.length + rawSuppliers.length + rawPurchases.length + rawCashObligations.length - rejectedRows, rejectedRows, duplicates: duplicateCount, coverage, matchedSkus, missingLeadTimes, unknownSkus, warnings, criticalErrors },
    summary: { availableCash, reserve, purchasingCapacity, overdueReceivables: overdueTotal },
    agents: { inventory: `requires ${safeReorder.required} ${safeReorder.sku}`, cashflow: cashRunway.shortageWeek ? `reserve risk in week ${cashRunway.shortageWeek}` : topCostFinding ? `reviews ₹${Math.round(topCostFinding.marginAtRisk30).toLocaleString("en-IN")} margin risk` : `funds ${safeReorder.approved} now`, sales: `protect ${safeReorder.sku}`, moderator: topCostFinding && actions[2].type === "cost_control" ? "cash-safe order plus supplier-cost review" : safeReorder.approved < safeReorder.required ? "runway-safe partial order plus collection" : "full order within runway constraints" },
    anomalies: { findings: anomalies, scannedRows: sales.length + inventory.length + receivables.length + suppliers.length + purchases.length + cashObligations.length, reportDate: analysisDate.toISOString().slice(0, 10) },
    reorder: { sku: safeReorder.sku, requiredUnits: safeReorder.required, approvedUnits: safeReorder.approved, unitCost: safeReorder.unitCost, leadTime: safeReorder.leadTime, packageSize: safeReorder.packageSize, moq: safeReorder.moq, forecastDaily: safeReorder.forecastDaily, availableStock: safeReorder.available },
    quant: { engine: "quant-v2", modelVersion: "argus-quant-v2", demandModelCoverage: Object.keys(demandModels).length, reliableDemandModelCoverage, averageDemandWape: demandWapes.length ? mean(demandWapes) : null, medianDemandWape: reliableDemandWapes.length ? median(reliableDemandWapes) : null, demandModels, demandAnomalies, costIntelligence },
    cashRunway,
  };
}
