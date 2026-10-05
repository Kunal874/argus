export type DemandPoint = { date: string; quantity: number };

export type DemandForecast = {
  model: "moving_average" | "seasonal_naive" | "exponential_smoothing" | "croston" | "tsb";
  modelVersion: "demand-v2";
  segment: "regular" | "intermittent" | "lumpy" | "new" | "inactive";
  status: "reliable" | "limited" | "abstained";
  historyDays: number;
  forecastDaily: number;
  forecast7: number;
  forecast14: number;
  forecast30: number;
  lower14: number;
  upper14: number;
  wape: number | null;
  metrics: { wape: number | null; mase: number | null; bias: number | null; pinball80: number | null; coverage80: number | null };
  validationFolds: number;
  abstentionReason?: string;
  confidence: "High" | "Medium" | "Low";
};

export type DemandAnomalyPrediction = {
  status: "detected" | "normal" | "abstained";
  model: DemandForecast["model"];
  date: string;
  actual: number;
  expected: number;
  lower: number;
  upper: number;
  residualScore: number | null;
  confidence: number;
  wape: number | null;
  reason: string;
};

export type CostObservation = {
  sku: string;
  productName: string;
  category: string;
  supplierId: string;
  supplierName: string;
  currentCost: number;
  quotedCost: number;
  sellingPrice: number;
  forecast30: number;
  leadTime: number;
  moq: number;
  packageSize: number;
  qualityRating: number;
  onTimeRate: number;
  observedAt?: string;
  quantity?: number;
  paymentTermDays?: number;
  freightPerUnit?: number;
  taxPerUnit?: number;
  alternativeEligible?: boolean;
};

export type CostFinding = {
  id: string;
  sku: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  actualCost: number;
  expectedCost: number;
  expectedLower: number;
  expectedUpper: number;
  changePercent: number;
  grossMarginPercent: number;
  expectedMarginPercent: number;
  marginErosionPoints: number;
  marginAtRisk30: number;
  confidence: number;
  likelyDriver: string;
  alternativeSupplier?: { supplierId: string; supplierName: string; quotedCost: number; savingPercent: number; leadTime: number };
  evidence: string[];
};

export type CostIntelligenceReport = {
  mode: "ml" | "fallback" | "unavailable";
  model: string;
  observations: number;
  holdoutMape: number | null;
  findings: CostFinding[];
  totalMarginAtRisk30: number;
  assumptions: string[];
  modelVersion: "supplier-cost-v2";
  status: "reliable" | "limited" | "abstained";
  promotionEligible: boolean;
};

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mad = (values: number[], center = median(values)) => median(values.map((value) => Math.abs(value - center)));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

const seasonalNaive = (series: number[], horizon: number) => {
  const season = series.slice(-Math.min(7, series.length));
  return Array.from({ length: horizon }, (_, index) => season[index % season.length] ?? 0);
};

const exponential = (series: number[], horizon: number, alpha = .35) => {
  let level = series[0] ?? 0;
  for (const value of series.slice(1)) level = alpha * value + (1 - alpha) * level;
  return Array(horizon).fill(level);
};

const croston = (series: number[], horizon: number, alpha = .2) => {
  const nonzero = series.map((value, index) => ({ value, index })).filter((item) => item.value > 0);
  if (!nonzero.length) return Array(horizon).fill(0);
  let demand = nonzero[0].value;
  let interval = Math.max(1, nonzero[0].index + 1);
  let previous = nonzero[0].index;
  for (const item of nonzero.slice(1)) {
    demand = alpha * item.value + (1 - alpha) * demand;
    interval = alpha * Math.max(1, item.index - previous) + (1 - alpha) * interval;
    previous = item.index;
  }
  return Array(horizon).fill(demand / interval);
};

const tsb = (series: number[], horizon: number, alpha = .2, beta = .15) => {
  let probability = series[0] > 0 ? 1 : 0;
  let demand = series.find((value) => value > 0) ?? 0;
  for (const value of series.slice(1)) {
    const occurred = value > 0 ? 1 : 0;
    probability = beta * occurred + (1 - beta) * probability;
    if (occurred) demand = alpha * value + (1 - alpha) * demand;
  }
  return Array(horizon).fill(probability * demand);
};

const wape = (actual: number[], predicted: number[]) => {
  const denominator = actual.reduce((sum, value) => sum + Math.abs(value), 0);
  return denominator ? actual.reduce((sum, value, index) => sum + Math.abs(value - (predicted[index] ?? 0)), 0) / denominator : 0;
};

const quantile = (values: number[], probability: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))];
};

const classifySeries = (series: number[]): DemandForecast["segment"] => {
  if (series.length < 28) return "new";
  if (!series.slice(-28).some((value) => value > 0)) return "inactive";
  const nonzero = series.filter((value) => value > 0);
  const adi = series.length / Math.max(1, nonzero.length);
  const average = mean(nonzero);
  const cv2 = average ? mean(nonzero.map((value) => (value - average) ** 2)) / (average ** 2) : 0;
  if (adi >= 1.32 && cv2 >= .49) return "lumpy";
  if (adi >= 1.32) return "intermittent";
  return "regular";
};

const generatorFor = (model: DemandForecast["model"]) => model === "seasonal_naive" ? seasonalNaive : model === "exponential_smoothing" ? exponential : model === "croston" ? croston : model === "tsb" ? tsb : (series: number[], horizon: number) => Array(horizon).fill(mean(series.slice(-Math.min(14, series.length))));

export function forecastDemand(points: DemandPoint[], horizon = 30): DemandForecast {
  if (!points.length) return { model: "moving_average", modelVersion: "demand-v2", segment: "new", status: "abstained", historyDays: 0, forecastDaily: 0, forecast7: 0, forecast14: 0, forecast30: 0, lower14: 0, upper14: 0, wape: null, metrics: { wape: null, mase: null, bias: null, pinball80: null, coverage80: null }, validationFolds: 0, abstentionReason: "No usable demand history was available.", confidence: "Low" };
  const daily = new Map<string, number>();
  for (const point of points) daily.set(point.date, (daily.get(point.date) ?? 0) + Math.max(0, point.quantity));
  const dates = [...daily.keys()].sort();
  const start = new Date(`${dates[0]}T00:00:00Z`);
  const end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const historyDays = Math.min(730, Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1));
  const series = Array.from({ length: historyDays }, (_, index) => daily.get(new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10)) ?? 0);
  const segment = classifySeries(series);
  let model: DemandForecast["model"] = "moving_average";
  let error: number | null = null;
  let selectedResiduals: number[] = [];
  let validationFolds = 0;
  let prediction: number[];
  if (series.length < 28) {
    prediction = Array(horizon).fill(mean(series.slice(-Math.min(14, series.length))));
  } else {
    const models: DemandForecast["model"][] = ["seasonal_naive", "exponential_smoothing", "croston", "tsb"];
    const foldHorizon = Math.min(14, Math.max(7, Math.floor(series.length / 8)));
    validationFolds = Math.min(3, Math.floor((series.length - 21) / foldHorizon));
    const evaluations = models.map((candidate) => {
      const actual: number[] = []; const predicted: number[] = [];
      for (let fold = validationFolds; fold >= 1; fold -= 1) {
        const end = series.length - (fold - 1) * foldHorizon;
        const start = end - foldHorizon;
        const train = series.slice(0, start);
        actual.push(...series.slice(start, end));
        predicted.push(...generatorFor(candidate)(train, foldHorizon));
      }
      return { model: candidate, error: wape(actual, predicted), actual, predicted };
    }).sort((a, b) => a.error - b.error);
    const baseline = evaluations.find((item) => item.model === "seasonal_naive")!;
    const challenger = evaluations[0];
    const selected = challenger.model !== baseline.model && challenger.error <= baseline.error * .95 ? challenger : baseline;
    model = selected.model; error = selected.error;
    selectedResiduals = selected.actual.map((value, index) => value - (selected.predicted[index] ?? 0));
    prediction = generatorFor(model)(series, horizon);
  }
  const forecast7 = prediction.slice(0, 7).reduce((sum, value) => sum + value, 0);
  const forecast14 = prediction.slice(0, 14).reduce((sum, value) => sum + value, 0);
  const forecast30 = prediction.reduce((sum, value) => sum + value, 0);
  const absoluteResiduals = selectedResiduals.map(Math.abs);
  const intervalRadius = absoluteResiduals.length ? quantile(absoluteResiduals, .8) * 14 : forecast14 * clamp(error ?? .3, .12, .4);
  const naiveScale = mean(series.slice(1).map((value, index) => Math.abs(value - series[index]))) || 1;
  const mase = selectedResiduals.length ? mean(absoluteResiduals) / naiveScale : null;
  const bias = selectedResiduals.length ? mean(selectedResiduals) / Math.max(1, mean(series)) : null;
  const coverage80 = selectedResiduals.length ? mean(selectedResiduals.map((value) => Math.abs(value) <= quantile(absoluteResiduals, .8) ? 1 : 0)) : null;
  const pinball80 = selectedResiduals.length ? mean(selectedResiduals.map((value) => value >= 0 ? .8 * value : .2 * -value)) : null;
  const status = segment === "inactive" ? "abstained" : series.length < 28 || (error ?? 1) > .75 ? "limited" : "reliable";
  return {
    model,
    modelVersion: "demand-v2",
    segment,
    status,
    historyDays: series.length,
    forecastDaily: forecast7 / 7,
    forecast7,
    forecast14,
    forecast30,
    lower14: Math.max(0, forecast14 - intervalRadius),
    upper14: forecast14 + intervalRadius,
    wape: error,
    metrics: { wape: error, mase, bias, pinball80, coverage80 },
    validationFolds,
    abstentionReason: status === "abstained" ? "No demand was recorded in the latest 28-day window." : status === "limited" ? "History or rolling-origin accuracy is not yet sufficient for a reliable model." : undefined,
    confidence: series.length < 28 ? "Low" : error !== null && error <= .2 ? "High" : error !== null && error <= .45 ? "Medium" : "Low",
  };
}

const nextValue = (series: number[], model: DemandForecast["model"]) => {
  if (!series.length) return 0;
  if (model === "seasonal_naive") return series[Math.max(0, series.length - 7)] ?? 0;
  if (model === "exponential_smoothing") return exponential(series, 1)[0] ?? 0;
  if (model === "croston") return croston(series, 1)[0] ?? 0;
  if (model === "tsb") return tsb(series, 1)[0] ?? 0;
  return mean(series.slice(-Math.min(14, series.length)));
};

export function detectDemandAnomaly(points: DemandPoint[]): DemandAnomalyPrediction {
  if (!points.length) return { status: "abstained", model: "moving_average", date: "", actual: 0, expected: 0, lower: 0, upper: 0, residualScore: null, confidence: 0, wape: null, reason: "No usable sales history was available." };
  const daily = new Map<string, number>();
  for (const point of points) daily.set(point.date, (daily.get(point.date) ?? 0) + Math.max(0, point.quantity));
  const dates = [...daily.keys()].sort();
  const start = new Date(`${dates[0]}T00:00:00Z`); const end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  const timeline = Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1 }, (_, index) => { const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10); return { date, value: daily.get(date) ?? 0 }; });
  const latest = timeline[timeline.length - 1];
  const training = timeline.slice(0, -1);
  const series = training.map((item) => item.value);
  if (training.length < 35) return { status: "abstained", model: "moving_average", date: latest.date, actual: latest.value, expected: mean(series), lower: 0, upper: 0, residualScore: null, confidence: 0, wape: null, reason: "At least 35 observed sales days are required for a backtested anomaly decision." };
  const holdout = Math.min(14, Math.max(7, Math.floor(series.length / 5)));
  const train = series.slice(0, -holdout);
  const actual = series.slice(-holdout);
  const candidates = [
    { model: "seasonal_naive" as const, values: seasonalNaive(train, holdout) },
    { model: "exponential_smoothing" as const, values: exponential(train, holdout) },
    { model: "croston" as const, values: croston(train, holdout) },
    { model: "tsb" as const, values: tsb(train, holdout) },
  ].map((candidate) => ({ ...candidate, error: wape(actual, candidate.values) })).sort((left, right) => left.error - right.error);
  const forecast = candidates[0];
  if (forecast.error > .75) return { status: "abstained", model: forecast.model, date: latest.date, actual: latest.value, expected: nextValue(series, forecast.model), lower: 0, upper: 0, residualScore: null, confidence: 0, wape: forecast.error, reason: "Backtest error is too high for a reliable anomaly decision." };
  const residuals: number[] = [];
  for (let index = Math.max(14, series.length - 35); index < series.length; index += 1) residuals.push(series[index] - nextValue(series.slice(0, index), forecast.model));
  const residualCenter = median(residuals);
  const residualScale = Math.max(1, mad(residuals, residualCenter) * 1.4826);
  const expected = Math.max(0, nextValue(series, forecast.model) + residualCenter);
  const threshold = Math.max(3, residualScale * 3, Math.sqrt(expected + 1) * 1.5);
  const lower = Math.max(0, expected - threshold);
  const upper = expected + threshold;
  const residualScore = Math.abs(latest.value - expected) / residualScale;
  const detected = latest.value < lower || latest.value > upper;
  const confidence = detected ? clamp(Math.round(92 - forecast.error * 30 + Math.min(8, Math.max(0, residualScore - 3) * 2)), 65, 95) : clamp(Math.round(92 - forecast.error * 35), 60, 92);
  return {
    status: detected ? "detected" : "normal",
    model: forecast.model,
    date: latest.date,
    actual: latest.value,
    expected,
    lower,
    upper,
    residualScore,
    confidence,
    wape: forecast.error,
    reason: detected ? "The latest observed sales day is outside the prediction interval built from backtested forecast residuals." : "The latest observed sales day remains inside the backtested prediction interval.",
  };
}

function solve(matrix: number[][], vector: number[]) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-10) return Array(size).fill(0);
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

const featureVector = (item: CostObservation) => [
  1,
  Math.log1p(item.currentCost),
  Math.log1p(item.moq),
  Math.log1p(item.packageSize),
  clamp(item.leadTime, 0, 90) / 30,
  clamp(item.qualityRating, 0, 5) / 5,
  clamp(item.onTimeRate, 0, 1),
];

function fitRidge(items: CostObservation[], suppliedWeights?: number[]) {
  const features = items.map(featureVector);
  const targets = items.map((item) => Math.log(Math.max(.01, item.quotedCost)));
  let weights = suppliedWeights ?? Array(items.length).fill(1);
  let coefficients = Array(features[0]?.length ?? 0).fill(0);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const size = coefficients.length;
    const xtx = Array.from({ length: size }, () => Array(size).fill(0));
    const xty = Array(size).fill(0);
    for (let row = 0; row < features.length; row += 1) {
      for (let left = 0; left < size; left += 1) {
        xty[left] += weights[row] * features[row][left] * targets[row];
        for (let right = 0; right < size; right += 1) xtx[left][right] += weights[row] * features[row][left] * features[row][right];
      }
    }
    for (let index = 1; index < size; index += 1) xtx[index][index] += .35;
    coefficients = solve(xtx, xty);
    const residuals = features.map((row, index) => targets[index] - row.reduce((sum, value, feature) => sum + value * coefficients[feature], 0));
    const center = median(residuals);
    const scale = Math.max(.015, mad(residuals, center) * 1.4826);
    weights = residuals.map((value) => Math.min(1, 1.5 * scale / Math.max(1e-9, Math.abs(value - center))));
  }
  return { coefficients, weights };
}

const predictLogCost = (item: CostObservation, coefficients: number[]) => featureVector(item).reduce((sum, value, index) => sum + value * coefficients[index], 0);

export function analyzeCosts(observations: CostObservation[], materiality = 500): CostIntelligenceReport {
  const valid = observations.filter((item) => item.currentCost > 0 && item.quotedCost > 0 && Number.isFinite(item.quotedCost)).sort((a, b) => String(a.observedAt ?? "").localeCompare(String(b.observedAt ?? "")));
  if (!valid.length) return { mode: "unavailable", model: "No usable supplier-price observations", observations: 0, holdoutMape: null, findings: [], totalMarginAtRisk30: 0, assumptions: ["A dated purchase ledger or supplier price history was not available, so Argus abstained from cost analysis."], modelVersion: "supplier-cost-v2", status: "abstained", promotionEligible: false };
  const mlReady = valid.length >= 30;
  let expected = new Map<CostObservation, { value: number; lower: number; upper: number }>();
  let holdoutMape: number | null = null;
  if (mlReady) {
    const split = Math.max(20, Math.floor(valid.length * .8));
    const training = valid.slice(0, split);
    const holdout = valid.slice(split);
    const holdoutModel = fitRidge(training);
    holdoutMape = holdout.length ? mean(holdout.map((item) => Math.abs(Math.exp(predictLogCost(item, holdoutModel.coefficients)) - item.quotedCost) / item.quotedCost)) : null;
    const model = fitRidge(valid);
    const residuals = valid.map((item) => Math.log(item.quotedCost) - predictLogCost(item, model.coefficients));
    const center = median(residuals);
    const band = Math.max(.04, mad(residuals, center) * 1.4826 * 2.8);
    const costRatios = valid.map((item) => item.quotedCost / item.currentCost);
    const ratioCenter = median(costRatios);
    const ratioBand = Math.max(.025, mad(costRatios, ratioCenter) * 1.4826 * 2.2);
    expected = new Map(valid.map((item) => {
      const prediction = Math.exp(predictLogCost(item, model.coefficients) + center);
      const robustBaseline = item.currentCost * ratioCenter;
      return [item, {
        value: Math.min(prediction, robustBaseline),
        lower: Math.min(prediction * Math.exp(-band), item.currentCost * Math.max(.01, ratioCenter - ratioBand)),
        upper: Math.min(prediction * Math.exp(band), item.currentCost * (ratioCenter + ratioBand)),
      }];
    }));
  } else {
    expected = new Map(valid.map((item) => {
      const comparison = item.currentCost;
      return [item, { value: comparison, lower: comparison * .9, upper: comparison * 1.1 }];
    }));
  }
  const bySku = new Map<string, CostObservation[]>();
  for (const item of valid) bySku.set(item.sku, [...(bySku.get(item.sku) ?? []), item]);
  const findings = valid.flatMap((item): CostFinding[] => {
    const range = expected.get(item)!;
    const difference = item.quotedCost - range.value;
    const marginAtRisk30 = Math.max(0, difference) * Math.max(0, item.forecast30);
    if (item.quotedCost <= range.upper || marginAtRisk30 < materiality) return [];
    const actualMargin = item.sellingPrice > 0 ? (item.sellingPrice - item.quotedCost) / item.sellingPrice * 100 : 0;
    const expectedMargin = item.sellingPrice > 0 ? (item.sellingPrice - range.value) / item.sellingPrice * 100 : 0;
    const alternatives = (bySku.get(item.sku) ?? []).filter((other) => other.supplierId !== item.supplierId && other.quotedCost < item.quotedCost && other.leadTime <= item.leadTime + 3 && other.alternativeEligible !== false).sort((a, b) => a.quotedCost - b.quotedCost);
    const alternative = alternatives[0];
    const confidence = mlReady ? clamp(Math.round(90 - (holdoutMape ?? .25) * 45), 62, 88) : 58;
    const likelyDriver = alternative ? "This supplier quote is above both the model range and an eligible alternative supplier." : item.leadTime > 20 ? "The quote increase is associated with an unusually long supplier lead time." : "The supplier quote is above the cost expected from comparable products and order terms.";
    return [{
      id: `quant-cost-${item.sku}-${item.supplierId}`,
      sku: item.sku,
      productName: item.productName,
      supplierId: item.supplierId,
      supplierName: item.supplierName,
      actualCost: item.quotedCost,
      expectedCost: range.value,
      expectedLower: range.lower,
      expectedUpper: range.upper,
      changePercent: difference / Math.max(.01, range.value) * 100,
      grossMarginPercent: actualMargin,
      expectedMarginPercent: expectedMargin,
      marginErosionPoints: Math.max(0, expectedMargin - actualMargin),
      marginAtRisk30,
      confidence,
      likelyDriver,
      alternativeSupplier: alternative ? { supplierId: alternative.supplierId, supplierName: alternative.supplierName, quotedCost: alternative.quotedCost, savingPercent: (item.quotedCost - alternative.quotedCost) / item.quotedCost * 100, leadTime: alternative.leadTime } : undefined,
      evidence: [`SKU ${item.sku}`, `Supplier ${item.supplierName}`, `Quoted cost INR ${Math.round(item.quotedCost).toLocaleString("en-IN")}`, `Expected range INR ${Math.round(range.lower).toLocaleString("en-IN")}-${Math.round(range.upper).toLocaleString("en-IN")}`, `30-day forecast ${Math.round(item.forecast30).toLocaleString("en-IN")} units`],
    }];
  }).sort((a, b) => b.marginAtRisk30 - a.marginAtRisk30 || b.changePercent - a.changePercent).slice(0, 8);
  return {
    mode: mlReady ? "ml" : "fallback",
    model: mlReady ? "Robust Ridge + product-cost MAD ensemble" : "Current-versus-last-price robust fallback",
    observations: valid.length,
    holdoutMape,
    findings,
    totalMarginAtRisk30: findings.reduce((sum, finding) => sum + finding.marginAtRisk30, 0),
    modelVersion: "supplier-cost-v2",
    status: mlReady ? "reliable" : "limited",
    promotionEligible: valid.filter((item) => item.observedAt).length >= 200,
    assumptions: [
      mlReady ? "The ensemble compares a robust Ridge prediction with the product's known-cost change pattern using MAD bands." : "Fewer than 30 usable supplier prices were available, so Argus used a transparent low-confidence fallback.",
      valid.some((item) => item.observedAt) ? "Dated landed-cost history is evaluated in time order; the server-side LightGBM challenger requires at least 200 usable lines before promotion." : "The supplied files do not contain a dated purchase ledger; cost confidence is capped and findings require owner verification.",
      "Predicted margin exposure is an estimate, not recorded savings.",
    ],
  };
}
