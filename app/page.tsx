"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeUploads, parseCsvFile, projectCashRunway, simulateReorder, type AnalysisAction as Action, type AnalysisDatasets, type CoreDatasetKey, type DatasetKey, type ParsedDataset, type UploadAnalysis } from "@/lib/client-analysis";
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_STORAGE_KEY, getLanguage, normalizeLanguageCode, type LanguageCode } from "@/lib/languages";
import { buildDeterministicLocalizedReport, type LocalizedDecisionReport, type MultilingualValidation } from "@/lib/multilingual-report";
import type { DecisionPackage } from "@/lib/reasoning";
import { UI_COPY } from "@/lib/ui-copy";
import { businessHealthCopy, deriveAttentionItems, deriveBusinessAreas, deriveBusinessHealth, getActionDisplayState, type PrimaryView } from "@/lib/owner-view-model";

type Screen = "welcome" | "upload" | "quality" | "progress" | PrimaryView | "detail" | "outcome";

const money = (value: number) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
}).format(value);

const baseActions: Action[] = [
  {
    id: "reorder-switch-a",
    type: "reorder",
    title: "Order 20 units of Switch A",
    subtitle: "Stockout projected in 6 days; supplier takes 10 days",
    urgency: "Critical",
    confidence: 88,
    amount: 16000,
    impact: "Protects approximately ₹25,000 in near-term sales",
    reason: "Demand is rising, but upcoming rent, salary and supplier obligations reduce the runway-safe purchase to 20 units.",
    evidence: ["Current usable stock: 38 units", "14-day forecast: 82 units", "Four-week safe purchasing capacity: ₹16,000", "Supplier lead time: 10 days"],
  },
  {
    id: "collect-sharma",
    type: "collection",
    title: "Confirm payment date with Sharma Electricals",
    subtitle: "₹74,000 is overdue by 12 days",
    urgency: "High",
    confidence: 94,
    amount: 74000,
    impact: "Unlocks the remaining Switch A purchase",
    reason: "This is a strategic customer who normally pays within five days, so Argus recommends a relationship-sensitive check-in—not an automatic demand.",
    evidence: ["Relationship: strategic · 4 years", "Normal delay: 3–5 days", "Current delay: 12 days", "No dispute recorded"],
  },
  {
    id: "defer-cable-b",
    type: "defer",
    title: "Pause the next Cable B purchase",
    subtitle: "71 days of stock cover; sales are down for 4 weeks",
    urgency: "Medium",
    confidence: 91,
    amount: 42000,
    impact: "Keeps ₹42,000 available for faster-moving stock",
    reason: "Cable B is moving 39% slower than its expected rate and already exceeds the 45-day stock target.",
    evidence: ["Current stock: 142 units", "Expected weekly sales: 32 units", "Actual weekly sales: 19 units", "Purchase price unchanged"],
  },
];

const pipeline = ["Data", "Cash", "Brief"];
const progressCopy = [
  "Checking your business data",
  "Checking what your cash can safely support",
  "Preparing your three verified decisions",
];

const NAV_LABELS: Record<LanguageCode, Record<PrimaryView, string>> = {
  en: { home: "Home", actions: "Actions", money: "Money", reports: "Reports", more: "More" },
  hi: { home: "होम", actions: "कार्रवाइयाँ", money: "पैसा", reports: "रिपोर्ट", more: "और" },
  bn: { home: "হোম", actions: "করণীয়", money: "টাকা", reports: "রিপোর্ট", more: "আরও" },
  te: { home: "హోమ్", actions: "చర్యలు", money: "డబ్బు", reports: "నివేదికలు", more: "మరిన్ని" },
  mr: { home: "मुख्यपृष्ठ", actions: "कृती", money: "पैसा", reports: "अहवाल", more: "अधिक" },
  ta: { home: "முகப்பு", actions: "செயல்கள்", money: "பணம்", reports: "அறிக்கைகள்", more: "மேலும்" },
  gu: { home: "હોમ", actions: "પગલાં", money: "પૈસા", reports: "અહેવાલ", more: "વધુ" },
  kn: { home: "ಮುಖಪುಟ", actions: "ಕ್ರಮಗಳು", money: "ಹಣ", reports: "ವರದಿಗಳು", more: "ಇನ್ನಷ್ಟು" },
  ml: { home: "ഹോം", actions: "നടപടികൾ", money: "പണം", reports: "റിപ്പോർട്ടുകൾ", more: "കൂടുതൽ" },
  pa: { home: "ਹੋਮ", actions: "ਕਾਰਵਾਈਆਂ", money: "ਪੈਸਾ", reports: "ਰਿਪੋਰਟਾਂ", more: "ਹੋਰ" },
  or: { home: "ହୋମ୍", actions: "ପଦକ୍ଷେପ", money: "ଟଙ୍କା", reports: "ରିପୋର୍ଟ", more: "ଅଧିକ" },
  as: { home: "হোম", actions: "পদক্ষেপ", money: "ধন", reports: "প্ৰতিবেদন", more: "অধিক" },
};

const demoRunway = projectCashRunway({
  asOfDate: "2026-08-08", availableCash: 120000, reserve: 70000, proposedPurchase: 48000, obligationsProvided: true,
  receivables: [
    { label: "Sharma Electricals - INV-1042", amount: 74000, expectedDate: "2026-08-15", probability: .55 },
    { label: "Verma Traders - INV-1078", amount: 62000, expectedDate: "2026-08-18", probability: .75 },
  ],
  obligations: [
    { label: "Shop rent", amount: 18000, date: "2026-08-12" },
    { label: "Staff salaries", amount: 16000, date: "2026-08-14" },
    { label: "Supplier payment", amount: 22000, date: "2026-08-20" },
  ],
});

const decisionPackageFrom = (result: UploadAnalysis): DecisionPackage => ({
  snapshot: { quality: result.quality, summary: result.summary, cash_runway: result.cashRunway, anomaly_report: result.anomalies, quant: result.quant },
  specialist_assessments: result.agents,
  verified_actions: result.actions,
  optimizer: result.reorder,
});

export default function Home() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const screenHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    window.setTimeout(() => screenHeadingRef.current?.focus(), 0);
  }, [screen]);
  const [selectedAction, setSelectedAction] = useState<Action>(baseActions[0]);
  const [budget, setBudget] = useState(50000);
  const [reserve, setReserve] = useState(70000);
  const [leadTime, setLeadTime] = useState(10);
  const [demandLift, setDemandLift] = useState(100);
  const [paymentDelay, setPaymentDelay] = useState(0);
  const [quotedCostPercent, setQuotedCostPercent] = useState(100);
  const [targetMargin, setTargetMargin] = useState(20);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [readingFile, setReadingFile] = useState<DatasetKey | null>(null);
  const [validationState, setValidationState] = useState<"idle" | "running">("idle");
  const [datasets, setDatasets] = useState<Partial<Record<DatasetKey, ParsedDataset>>>({});
  const [uploadErrors, setUploadErrors] = useState<Partial<Record<DatasetKey, string>>>({});
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [tone, setTone] = useState("payment-date");
  const [approved, setApproved] = useState(false);
  const [approvalState, setApprovalState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [approvalResult, setApprovalResult] = useState<{ whatsappDeepLink?: string } | null>(null);
  const [outcomeType, setOutcomeType] = useState("stockout_avoided");
  const [outcomeAmount, setOutcomeAmount] = useState(0);
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [outcomeState, setOutcomeState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [weeklySummary, setWeeklySummary] = useState<{ outcomes: number; measuredValue: number; stockoutRisksAddressed: number; autonomousActions: number } | null>(null);
  const [snapshotState, setSnapshotState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [reportState, setReportState] = useState<"idle" | "generating" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [moderatorExplanation, setModeratorExplanation] = useState<string | null>(null);
  const [reasoningMode, setReasoningMode] = useState("deterministic-fallback");
  const [selectedLanguage, setSelectedLanguage] = useState<LanguageCode>(DEFAULT_LANGUAGE);
  const [localizedReport, setLocalizedReport] = useState<LocalizedDecisionReport | null>(null);
  const [multilingualValidation, setMultilingualValidation] = useState<MultilingualValidation | null>(null);
  const [languageReportState, setLanguageReportState] = useState<"idle" | "generating" | "ready">("idle");

  useEffect(() => {
    setSelectedLanguage(normalizeLanguageCode(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, selectedLanguage);
    document.documentElement.lang = selectedLanguage;
  }, [selectedLanguage]);

  const copy = UI_COPY[selectedLanguage];
  const activeLanguage = getLanguage(selectedLanguage);

  const actions = analysis?.actions ?? baseActions;
  const localizedActions = new Map(localizedReport?.actions.map((action) => [action.type, action]) ?? []);
  const selectedLocalizedAction = localizedActions.get(selectedAction.type);
  const selectedActionable = selectedAction.amount > 0;
  const journeyStep = screen === "upload" ? 0 : screen === "quality" || screen === "progress" ? 1 : -1;
  const primaryViews: Array<{ id: PrimaryView; label: string; icon: string }> = [
    { id: "home", label: NAV_LABELS[selectedLanguage].home, icon: "⌂" },
    { id: "actions", label: NAV_LABELS[selectedLanguage].actions, icon: "✓" },
    { id: "money", label: NAV_LABELS[selectedLanguage].money, icon: "₹" },
    { id: "reports", label: NAV_LABELS[selectedLanguage].reports, icon: "▤" },
    { id: "more", label: NAV_LABELS[selectedLanguage].more, icon: "•••" },
  ];
  const isPrimaryView = primaryViews.some((item) => item.id === screen);
  const reorderMeta = useMemo(() => selectedAction.type === "reorder" && selectedAction.meta ? selectedAction.meta : analysis ? {
    requiredUnits: analysis.reorder.requiredUnits,
    unitCost: analysis.reorder.unitCost,
    leadTime: analysis.reorder.leadTime,
    packageSize: analysis.reorder.packageSize,
    moq: analysis.reorder.moq,
    forecastDaily: analysis.reorder.forecastDaily,
    availableStock: analysis.reorder.availableStock,
    sku: analysis.reorder.sku,
  } : { requiredUnits: 100, unitCost: 800, leadTime: 10, packageSize: 10, moq: 10 }, [analysis, selectedAction]);
  const scenarioSource = analysis?.cashRunway ?? demoRunway;
  const scenarioAvailableCash = analysis?.summary.availableCash ?? 120000;
  const prePurchaseRunway = useMemo(() => projectCashRunway({
    asOfDate: scenarioSource.asOfDate,
    availableCash: scenarioAvailableCash,
    reserve,
    receivables: scenarioSource.inputs.receivables,
    obligations: scenarioSource.inputs.obligations,
    proposedPurchase: 0,
    paymentDelayDays: paymentDelay,
    obligationsProvided: scenarioSource.inputs.obligations.length > 0,
  }), [scenarioSource, scenarioAvailableCash, reserve, paymentDelay]);
  const runwaySafeBudget = Math.max(0, Math.min(budget, Math.min(...prePurchaseRunway.weeks.slice(0, 4).map((week) => week.conservativeBalance)) - reserve));
  const simulation = useMemo(() => simulateReorder({
    availableCash: scenarioAvailableCash,
    budget: runwaySafeBudget,
    reserve,
    requiredUnits: Number(reorderMeta.requiredUnits ?? 100),
    unitCost: Number(reorderMeta.unitCost ?? 800),
    packageSize: Number(reorderMeta.packageSize ?? 10),
    moq: Number(reorderMeta.moq ?? 10),
    leadTime,
    baseLeadTime: Number(reorderMeta.leadTime ?? 10),
    demandMultiplier: demandLift / 100,
  }), [scenarioAvailableCash, runwaySafeBudget, reserve, leadTime, demandLift, reorderMeta]);
  const affordableUnits = simulation.approvedUnits;
  const runway = useMemo(() => projectCashRunway({
    asOfDate: scenarioSource.asOfDate,
    availableCash: scenarioAvailableCash,
    reserve,
    receivables: scenarioSource.inputs.receivables,
    obligations: scenarioSource.inputs.obligations,
    proposedPurchase: simulation.approvedUnits * Number(reorderMeta.unitCost ?? 0),
    paymentDelayDays: paymentDelay,
    obligationsProvided: scenarioSource.inputs.obligations.length > 0,
  }), [scenarioSource, scenarioAvailableCash, reserve, simulation.approvedUnits, reorderMeta.unitCost, paymentDelay]);
  const runwayMax = Math.max(reserve, ...runway.weeks.map((week) => Math.max(0, week.expectedBalance, week.conservativeBalance)));
  const coreUploadCount = (["sales", "inventory", "receivables", "suppliers"] as CoreDatasetKey[]).filter((key) => datasets[key]).length;
  const simulatedQuote = Number(selectedAction.meta?.unitCost ?? 0) * quotedCostPercent / 100;
  const simulatedMinimumSellingPrice = targetMargin < 100 ? simulatedQuote / (1 - targetMargin / 100) : 0;
  const simulatedMarginExposure = Math.max(0, simulatedQuote - Number(selectedAction.meta?.expectedCost ?? simulatedQuote)) * Number(selectedAction.meta?.forecastDaily ?? 0) * 30;
  const health = analysis ? deriveBusinessHealth(analysis) : "needs-attention";
  const healthCopy = businessHealthCopy(health);
  const attentionItems = analysis ? deriveAttentionItems(analysis) : [];
  const businessAreas = analysis ? deriveBusinessAreas(analysis) : [];
  const topAction = actions.find((action) => action.amount > 0) ?? actions[0];

  const handleFile = async (key: DatasetKey, file?: File) => {
    if (!file) return;
    setReadingFile(key);
    try {
      const parsed = await parseCsvFile(file, key);
      setDatasets((old) => ({ ...old, [key]: parsed }));
      setFiles((old) => ({ ...old, [key]: file.name }));
      setUploadErrors((old) => ({ ...old, [key]: undefined }));
    } catch (error) {
      setDatasets((old) => { const next = { ...old }; delete next[key]; return next; });
      setFiles((old) => { const next = { ...old }; delete next[key]; return next; });
      setUploadErrors((old) => ({ ...old, [key]: error instanceof Error ? error.message : "Could not read this CSV." }));
    } finally {
      setReadingFile(null);
    }
  };

  const saveAnalysisSnapshot = async (result: UploadAnalysis) => {
    setSnapshotState("saving");
    try {
      const response = await fetch("/api/analysis-snapshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: result }) });
      if (!response.ok) throw new Error("Snapshot could not be saved");
      setSnapshotState("saved");
    } catch {
      setSnapshotState("error");
    }
  };

  const requestReasoning = async (result: UploadAnalysis, languageCode: LanguageCode) => {
    const decisionPackage = decisionPackageFrom(result);
    setLanguageReportState("generating");
    try {
      const response = await fetch("/api/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ languageCode, decisionPackage }),
      });
      if (!response.ok) throw new Error("Explanation request failed");
      const data = await response.json();
      setModeratorExplanation(data.explanation);
      setReasoningMode(data.mode);
      setLocalizedReport(data.localizedReport);
      setMultilingualValidation(data.multilingualValidation);
    } catch {
      const fallback = buildDeterministicLocalizedReport(decisionPackage, languageCode);
      setLocalizedReport(fallback);
      setMultilingualValidation(null);
      setModeratorExplanation([fallback.summary, fallback.riskSummary, fallback.ownerControl].join(" "));
      setReasoningMode("deterministic-fallback-after-provider-error");
    } finally {
      setLanguageReportState("ready");
    }
  };

  const validateUploads = () => {
    const keys: CoreDatasetKey[] = ["sales", "inventory", "receivables", "suppliers"];
    if (!keys.every((key) => datasets[key])) return;
    setValidationState("running");
    window.setTimeout(() => {
      const result = analyzeUploads(datasets as AnalysisDatasets, budget, reserve);
      setAnalysis(result);
      setSelectedAction(result.actions[0]);
      setLeadTime(result.reorder.leadTime);
      setModeratorExplanation(null);
      if (result.quality.analysisReady) void saveAnalysisSnapshot(result);
      if (result.quality.analysisReady) void requestReasoning(result, selectedLanguage);
      setValidationState("idle");
      setScreen("quality");
    }, 50);
  };

  const downloadBusinessReport = async () => {
    setReportState("generating");
    try {
      const response = await fetch(`/api/business-report?language=${selectedLanguage}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localizedReport }),
      });
      if (!response.ok) throw new Error("Report could not be generated");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `argus-business-report-${selectedLanguage}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setReportState("idle");
    } catch {
      setReportState("error");
    }
  };

  const runAnalysis = () => {
    setScreen("progress");
    setProgress(0);
    pipeline.forEach((_, index) => {
      window.setTimeout(() => setProgress(index + 1), 240 * (index + 1));
    });
    window.setTimeout(() => setScreen("home"), 2100);
  };

  useEffect(() => {
    if (screen !== "reports" || !analysis) return;
    void fetch("/api/weekly-summary")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Summary failed")))
      .then(setWeeklySummary)
      .catch(() => undefined);
  }, [screen, analysis]);

  const openDetail = (action: Action) => {
    setSelectedAction(action);
    setApproved(false);
    setApprovalState("idle");
    setApprovalResult(null);
    if (action.type === "collection") setTone(action.meta?.strategic || action.meta?.disputed ? "call" : "payment-date");
    setScreen("detail");
  };

  const approveSelectedAction = async () => {
    setApprovalState("saving");
    try {
      const response = await fetch("/api/approvals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        actionId: selectedAction.id, actionType: selectedAction.type,
        relationshipAction: selectedAction.type === "collection" ? tone : undefined, amount: selectedAction.amount,
      }) });
      if (!response.ok) throw new Error("Approval could not be saved");
      setApprovalResult(await response.json());
      setApproved(true);
      setApprovalState("success");
    } catch {
      setApprovalState("error");
    }
  };

  const openOutcome = () => {
    const type = selectedAction.type === "collection" ? "payment_received" : selectedAction.type === "defer" ? "purchase_avoided" : selectedAction.type === "cost_control" ? "margin_protected" : "stockout_avoided";
    setOutcomeType(type);
    setOutcomeAmount(0);
    setOutcomeNotes("");
    setOutcomeState("idle");
    setScreen("outcome");
  };

  const recordSelectedOutcome = async () => {
    setOutcomeState("saving");
    try {
      const response = await fetch("/api/outcomes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        actionId: selectedAction.id, actionType: selectedAction.type,
        outcomeType, amount: outcomeAmount, notes: outcomeNotes,
      }) });
      if (!response.ok) throw new Error("Outcome could not be saved");
      const summaryResponse = await fetch("/api/weekly-summary");
      if (!summaryResponse.ok) throw new Error("Summary could not be loaded");
      setWeeklySummary(await summaryResponse.json());
      setOutcomeState("success");
    } catch {
      setOutcomeState("error");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setScreen("welcome")} aria-label="Go to Argus home">
          <span className="brand-mark">A</span>
          <span><strong>ARGUS</strong><small>Business cash assistant</small></span>
        </button>
          {isPrimaryView && analysis ? <nav className="owner-nav" aria-label="Main navigation">{primaryViews.map((item) => <button className={screen === item.id ? "active" : ""} aria-current={screen === item.id ? "page" : undefined} onClick={() => setScreen(item.id)} key={item.id}>{item.label}</button>)}</nav> : journeyStep >= 0 ? <nav className="journey" aria-label="Business check progress">{["Add data", "Check data", "See results"].map((label, index) => <span className={index <= journeyStep ? "active" : ""} key={label}><i />{label}</span>)}</nav> : <span />}
        <div className="topbar-tools">
          <label className="language-control">
            <span aria-hidden="true">🌐</span>
            <span className="language-control-copy"><small>{copy.language}</small><b>{activeLanguage.nativeName}</b></span>
            <select aria-label={copy.chooseLanguage} value={selectedLanguage} onChange={(event) => {
              const nextLanguage = normalizeLanguageCode(event.currentTarget.value);
              setSelectedLanguage(nextLanguage);
              if (analysis?.quality.analysisReady) void requestReasoning(analysis, nextLanguage);
            }}>
              {LANGUAGES.map((language) => <option value={language.code} key={language.code}>{language.nativeName} — {language.englishName}</option>)}
            </select>
          </label>
          <div className="business-pill"><span className="live-dot" /> Mehra Electricals <b>Demo</b></div>
        </div>
      </header>

      {screen === "welcome" && (
        <section className="hero screen">
          <div className="hero-copy">
            <p className="eyebrow">{copy.welcomeEyebrow}</p>
            <h1 ref={screenHeadingRef} tabIndex={-1}>{copy.welcomeTitle}</h1>
            <p className="lede">{copy.welcomeLede}</p>
            <div className="hero-actions">
              <button className="primary" onClick={() => setScreen("upload")}>{copy.analyze} <span>→</span></button>
            </div>
            <div className="trust-row"><span>{copy.humanApproved}</span><span>{copy.evidenceLinked}</span><span>{copy.builtForIndia}</span></div>
          </div>
          <div className="hero-panel">
            <div className="morning-label"><span>8:30 AM</span> YOUR MORNING BRIEF</div>
            <div className="hero-number">3</div>
            <h2>decisions need you today</h2>
            <div className="mini-action critical"><i /> Prevent a stockout <b>₹25k protected</b></div>
            <div className="mini-action"><i /> Collect a strategic payment <b>₹74k due</b></div>
            <div className="mini-action calm"><i /> Avoid excess purchasing <b>₹42k retained</b></div>
            <p className="microcopy">Calculated from the same verified business snapshot.</p>
          </div>
        </section>
      )}

      {screen === "upload" && (
        <section className="screen narrow">
          <div className="step-line" aria-label="Step 1 of 3"><span className="active">1</span><i /><span>2</span><i /><span>3</span></div>
          <p className="eyebrow">{copy.addData}</p>
          <h1 ref={screenHeadingRef} tabIndex={-1}>{copy.uploadTitle}</h1>
          <p className="section-intro">{copy.uploadIntro}</p>
          <div className="upload-grid">
            {[
              ["sales", "Sales", "Invoices, products, quantities and prices"],
              ["inventory", "Stock", "Current stock, purchase cost and incoming units"],
              ["receivables", "Customer payments", "Due dates and outstanding amounts"],
              ["suppliers", "Suppliers", "Lead times, minimum orders and package sizes"],
              ["purchases", "Purchase history (recommended)", "Dated orders, quantities and landed costs"],
              ["cashObligations", "Cash commitments (recommended)", "Rent, salaries, GST, EMI and committed supplier payments"],
            ].map(([key, title, desc]) => (
              <label className={`upload-card ${key === "cashObligations" || key === "purchases" ? "optional" : ""} ${files[key] ? "complete" : ""} ${uploadErrors[key as DatasetKey] ? "error" : ""}`} key={key}>
                <input type="file" accept=".csv,text/csv" onChange={(e) => handleFile(key as DatasetKey, e.target.files?.[0])} />
                <span className="upload-icon">{files[key] ? "✓" : "+"}</span>
                 <div><strong>{title}</strong><p>{readingFile === key ? "Reading and checking this file…" : uploadErrors[key as DatasetKey] || files[key] || desc}</p></div>
              </label>
            ))}
          </div>
          <details className="template-disclosure"><summary>Need a file template?</summary><div className="template-links">{[["sales", "Sales"], ["inventory", "Stock"], ["receivables", "Customer payments"], ["suppliers", "Suppliers"], ["purchases", "Purchase history"], ["cash_obligations", "Cash commitments"]].map(([file, label]) => <a href={`/samples/${file}.csv`} download key={file}>{label} template ↓</a>)}</div></details>
          <div className="settings-strip" aria-label="Business assumptions">
             <label>Amount available for purchases <input value={budget} onChange={(e) => setBudget(Number(e.target.value))} type="number" min="0" required /></label>
             <label>Cash to keep untouched <input value={reserve} onChange={(e) => setReserve(Number(e.target.value))} type="number" min="0" required /></label>
          </div>
           <div className="footer-actions"><button className="text-button" disabled={validationState === "running"} onClick={() => setScreen("welcome")}>{copy.back}</button><button className="primary" disabled={coreUploadCount !== 4 || validationState === "running"} onClick={validateUploads}>{validationState === "running" ? copy.checking : coreUploadCount === 4 ? `${copy.validate} →` : `Upload ${4 - coreUploadCount} more core file${4 - coreUploadCount === 1 ? "" : "s"}`}</button></div>
        </section>
      )}

      {screen === "quality" && (
        <section className="screen narrow">
          <div className="step-line" aria-label="Step 2 of 3"><span>1</span><i /><span className="active">2</span><i /><span>3</span></div>
          <p className="eyebrow">{copy.dataCheck}</p>
          <h1 ref={screenHeadingRef} tabIndex={-1}>{!analysis?.quality.analysisReady ? "A few issues need attention." : analysis.quality.warnings.length ? "Ready, with a few assumptions." : copy.ready}</h1>
          <p className="section-intro">{analysis?.quality.analysisReady ? "We found enough reliable information to continue. Review the transparent assumptions below." : "Critical fields are missing or unusable. Correct the files before analysis so Argus does not create misleading actions."}</p>
          <div className="quality-hero"><em>{analysis?.quality.analysisReady ? "Ready to analyze" : "Correction required"}</em><div><strong>{analysis?.quality.validRows.toLocaleString("en-IN") ?? "0"}</strong><span>usable records</span></div><div><strong>{analysis?.quality.coverage ?? 0}%</strong><span>products matched</span></div><div><strong>{analysis?.quality.rejectedRows ?? 0}</strong><span>rows rejected</span></div></div>
          <details className="quality-disclosure">
            <summary>What Argus adjusted</summary>
            <div className="quality-list">
            {(analysis?.quality.criticalErrors ?? []).map((issue) => <div className="quality-row warn" key={issue}><b>!</b><span><strong>Analysis blocked</strong><small>{issue}</small></span></div>)}
            <div className={`quality-row ${analysis?.quality.coverage ? "good" : "warn"}`}><b>✓</b><span><strong>Sales and inventory coverage checked</strong><small>{analysis?.quality.matchedSkus ?? 0} sales SKUs matched to the uploaded inventory.</small></span></div>
            {(analysis?.quality.warnings.length ?? 0) > 0 ? analysis?.quality.warnings.map((warning) => <div className="quality-row warn" key={warning}><b>!</b><span><strong>Transparent assumption</strong><small>{warning}</small></span></div>) : <div className="quality-row good"><b>✓</b><span><strong>Supplier terms are complete</strong><small>Every inventory SKU has an uploaded supplier lead time.</small></span></div>}
            <div className="quality-row good"><b>✓</b><span><strong>Analysis will use these uploads</strong><small>Forecasts, stock cover, receivables and actions are calculated from the rows you selected.</small></span></div>
            </div>
          </details>
          <div className="footer-actions"><button className="text-button" onClick={() => setScreen("upload")}>{copy.back}</button><button className="primary" disabled={!analysis?.quality.analysisReady} onClick={runAnalysis}>{analysis?.quality.analysisReady ? `${copy.runAnalysis} →` : "Correct files to continue"}</button></div>
        </section>
      )}

      {screen === "progress" && (
        <section className="screen processing">
          <p className="eyebrow">{copy.analyzing}</p>
          <h1 ref={screenHeadingRef} tabIndex={-1}>{copy.findingAttention}</h1>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress / pipeline.length * 100)} aria-label="Preparing your business check"><span style={{ width: `${Math.round(progress / pipeline.length * 100)}%` }} /></div>
          <p className="progress-message" aria-live="polite">{progressCopy[Math.min(progress, progressCopy.length - 1)]}</p>
          <p className="microcopy">{copy.filesUnchanged}</p>
        </section>
      )}

      {screen === "home" && analysis && (
        <section className="screen owner-home">
          <div className={`health-hero ${health}`}>
            <div>
              <p className="eyebrow">{healthCopy.eyebrow}</p>
              <h1 ref={screenHeadingRef} tabIndex={-1}>{healthCopy.title}</h1>
              <p>{healthCopy.detail}</p>
              <small>Latest business check · {analysis.anomalies.reportDate}</small>
            </div>
            <div className="health-count"><strong>{attentionItems.length}</strong><span>{attentionItems.length === 1 ? "item needs" : "items need"}<br />your attention</span></div>
          </div>

          <section className="top-recommendation" aria-labelledby="top-action-title">
            <div className="recommendation-copy">
              <p className="eyebrow">WHAT TO DO NEXT</p>
              <span className={`plain-status ${getActionDisplayState(topAction)}`}>{getActionDisplayState(topAction) === "no-action" ? "No action needed" : topAction.urgency === "Critical" ? "Act today" : "Recommended"}</span>
              <h2 id="top-action-title">{localizedActions.get(topAction.type)?.title ?? topAction.title}</h2>
              <p>{localizedActions.get(topAction.type)?.reason ?? topAction.reason}</p>
              <strong>{localizedActions.get(topAction.type)?.impact ?? topAction.impact}</strong>
            </div>
            <button className="primary" onClick={() => openDetail(topAction)}>Review this action →</button>
          </section>

          <div className="owner-money-strip" aria-label="Important money information">
            <button onClick={() => setScreen("money")}><span>Safe to spend</span><strong>{money(analysis.summary.purchasingCapacity)}</strong><small>without using protected cash</small></button>
            <button onClick={() => setScreen("money")}><span>Cash kept aside</span><strong>{money(analysis.summary.reserve)}</strong><small>your entered minimum</small></button>
            <button onClick={() => setScreen("money")}><span>Payments to collect</span><strong>{money(analysis.summary.overdueReceivables)}</strong><small>from uploaded receivables</small></button>
          </div>

          {localizedReport && <section className="owner-explanation" aria-live="polite"><span>{activeLanguage.nativeName}</span><p>{localizedReport.summary}</p><small>{localizedReport.riskSummary}</small></section>}
          {languageReportState === "generating" && <section className="owner-explanation loading" role="status">Preparing your verified explanation…</section>}

          <div className="home-grid">
            <section className="home-section">
              <div className="section-heading"><div><p className="eyebrow">TODAY&apos;S DECISIONS</p><h2>Two more decisions to review</h2></div><button className="text-button" onClick={() => setScreen("actions")}>See all three →</button></div>
              <div className="compact-action-list">{actions.filter((action) => action.id !== topAction.id).map((action) => <button onClick={() => openDetail(action)} key={action.id}><span className={`status-dot ${getActionDisplayState(action)}`} /><span><b>{localizedActions.get(action.type)?.title ?? action.title}</b><small>{getActionDisplayState(action) === "no-action" ? "No action needed" : action.impact}</small></span><i>→</i></button>)}</div>
            </section>
            <aside className="attention-panel">
              <p className="eyebrow">NEEDS ATTENTION</p>
              <h2>{attentionItems.length ? `${attentionItems.length} item${attentionItems.length === 1 ? "" : "s"} to check` : "Nothing urgent to check"}</h2>
              {attentionItems.length ? attentionItems.slice(0, 3).map((item) => <button onClick={() => item.action ? openDetail(item.action) : setScreen("more")} key={item.id}><span className={item.severity}>!</span><span><b>{item.label}</b><small>{item.detail}</small></span></button>) : <p>Your latest check has no critical action or high-priority unusual activity.</p>}
            </aside>
          </div>

          <section className="business-areas">
            <div className="section-heading"><div><p className="eyebrow">YOUR BUSINESS AREAS</p><h2>Where things stand</h2></div><small>Based on the latest uploaded files</small></div>
            <div>{businessAreas.map((area) => <button onClick={() => area.action ? openDetail(area.action) : setScreen(area.target)} key={area.id}><span className={`area-mark ${area.tone}`} aria-hidden="true" /><span><b>{area.label}</b><strong>{area.status}</strong><small>{area.detail}</small></span><i>→</i></button>)}</div>
          </section>
        </section>
      )}

      {screen === "actions" && analysis && (
        <section className="screen actions-workspace">
          <div className="workspace-heading"><div><p className="eyebrow">WHAT TO DO</p><h1 ref={screenHeadingRef} tabIndex={-1}>Your three decisions</h1><p>Ordered by urgency and likely business impact. You approve every external step.</p></div><button className="secondary" onClick={() => setScreen("upload")}>Update data</button></div>
          <div className="owner-action-list">{actions.map((action, index) => {
            const state = getActionDisplayState(action);
            return <article className={state} key={action.id}>
              <span className="decision-number">0{index + 1}</span>
              <div><span className={`plain-status ${state}`}>{state === "no-action" ? "No action needed" : action.urgency === "Critical" ? "Act today" : action.urgency === "High" ? "Needs attention" : "Review"}</span><h2>{localizedActions.get(action.type)?.title ?? action.title}</h2><p>{localizedActions.get(action.type)?.reason ?? action.reason}</p><strong>{localizedActions.get(action.type)?.impact ?? action.impact}</strong><details><summary>How certain is Argus?</summary><p>{action.confidence}% confidence · {action.subtitle}</p></details></div>
              <button className="secondary" onClick={() => openDetail(action)}>Review action →</button>
            </article>;
          })}</div>
        </section>
      )}

      {screen === "money" && analysis && (
        <section className="screen money-workspace">
          <div className="workspace-heading"><div><p className="eyebrow">YOUR MONEY</p><h1 ref={screenHeadingRef} tabIndex={-1}>{runway.shortageWeek ? `Cash needs attention in week ${runway.shortageWeek}.` : "Your protected cash remains safe."}</h1><p>See what is safe to spend, what is due to come in, and what could put pressure on cash.</p></div><span className={`cash-status ${runway.status.toLowerCase().replace(" ", "-")}`}>{runway.status}</span></div>
          <div className="owner-money-strip large">
            <div><span>Safe to spend</span><strong>{money(analysis.summary.purchasingCapacity)}</strong><small>after protecting your reserve</small></div>
            <div><span>Cash kept aside</span><strong>{money(analysis.summary.reserve)}</strong><small>your minimum untouched cash</small></div>
            <div><span>Payments to collect</span><strong>{money(analysis.summary.overdueReceivables)}</strong><small>outstanding in your files</small></div>
          </div>
          <section className={`cash-runway owner-runway ${runway.status.toLowerCase().replace(" ", "-")}`} aria-labelledby="cash-outlook-title">
            <div className="runway-head"><div><p className="eyebrow">CASH OUTLOOK · 13 WEEKS</p><h2 id="cash-outlook-title">{runway.cashGap ? `${money(runway.cashGap)} may fall short in week ${runway.shortageWeek}.` : "No reserve shortfall is currently projected."}</h2><span>Expected customer payments are reduced for uncertainty instead of treated as guaranteed.</span></div></div>
            <div className="runway-metrics"><div><span>Lowest likely balance</span><strong>{money(runway.minimumConservativeBalance)}</strong></div><div><span>Amount that may fall short</span><strong className={runway.cashGap ? "amber" : "green"}>{runway.cashGap ? money(runway.cashGap) : "No shortfall"}</strong></div><div><span>Expected payments</span><strong>{money(runway.totalExpectedInflows)}</strong></div><div><span>Committed outflows</span><strong>{money(runway.totalCommittedOutflows)}</strong></div></div>
            <details className="runway-visual"><summary>See the full 13-week cash outlook</summary><p className="chart-summary">{runway.shortageWeek ? `The first balance below your protected reserve is projected in week ${runway.shortageWeek}.` : `Every projected weekly balance remains at or above ${money(reserve)}.`}</p><div className="runway-chart" aria-label="Conservative balance by week">{runway.weeks.map((week) => <div className={week.conservativeBalance < reserve ? "below" : ""} key={week.week} title={`${week.label}: ${money(week.conservativeBalance)} likely balance`}><i style={{ height: `${Math.max(7, Math.min(100, Math.max(0, week.conservativeBalance) / runwayMax * 100))}%` }} /><span>W{week.week}</span></div>)}</div></details>
            <details className="runway-details"><summary>Weekly cash drivers and assumptions</summary><div>{runway.weeks.filter((week) => week.expectedInflows || week.committedOutflows || week.proposedPurchases).map((week) => <p key={week.week}><b>Week {week.week}</b><span>{week.driver}</span><strong>{money(week.conservativeBalance)}</strong></p>)}</div><ul>{runway.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details>
          </section>
          <section className="money-cards">
            <article><p className="eyebrow">CUSTOMER PAYMENTS</p><h2>{analysis.summary.overdueReceivables ? `${money(analysis.summary.overdueReceivables)} is waiting to be collected.` : "No overdue payment needs action."}</h2><p>{actions.find((action) => action.type === "collection")?.reason}</p><button className="text-button" onClick={() => openDetail(actions.find((action) => action.type === "collection") ?? actions[1])}>Review payment action →</button></article>
            <article><p className="eyebrow">SUPPLIER PRICE CHECK</p><h2>{analysis.quant.costIntelligence.findings.length ? "A supplier price needs checking." : "No material supplier-price pressure."}</h2><p>{analysis.quant.costIntelligence.findings[0] ? `${analysis.quant.costIntelligence.findings[0].productName} has ${money(analysis.quant.costIntelligence.findings[0].marginAtRisk30)} of estimated 30-day profit at risk.` : "Current costs are inside the expected ranges from the uploaded data."}</p>{analysis.quant.costIntelligence.findings[0] && <button className="text-button" onClick={() => openDetail(actions.find((action) => action.type === "cost_control") ?? actions[2])}>Review supplier price →</button>}</article>
          </section>
        </section>
      )}

      {screen === "reports" && analysis && (
        <section className="screen reports-workspace">
          <div className="workspace-heading"><div><p className="eyebrow">REVIEW RESULTS</p><h1 ref={screenHeadingRef} tabIndex={-1}>Reports and real outcomes</h1><p>Download the latest verified business report and track only value that actually happened.</p></div></div>
          <section className="latest-report-card"><span className="report-mark">PDF</span><div><small>LATEST BUSINESS CHECK · {analysis.anomalies.reportDate}</small><h2>{copy.reportTitle}</h2><p>{copy.reportIntro}</p><span>{activeLanguage.nativeName} · Latest report only</span></div><button className="primary" disabled={snapshotState === "saving" || reportState === "generating" || languageReportState === "generating"} onClick={snapshotState === "error" ? () => void saveAnalysisSnapshot(analysis) : downloadBusinessReport}>{snapshotState === "saving" ? "Saving latest check…" : snapshotState === "error" ? "Retry report preparation" : reportState === "generating" ? copy.preparingReport : copy.downloadReport}</button>{reportState === "error" && <small role="alert">{copy.reportError}</small>}</section>
          <section className="measured-results"><div><p className="eyebrow">THIS WEEK&apos;S MEASURED VALUE</p><h2>What actually happened</h2><p>Estimated impact is never counted here. Only outcomes you recorded after approval are included.</p></div><div className="result-metrics"><span><strong>{money(weeklySummary?.measuredValue ?? 0)}</strong><small>recorded value</small></span><span><strong>{weeklySummary?.stockoutRisksAddressed ?? 0}</strong><small>stockout risks addressed</small></span><span><strong>{weeklySummary?.outcomes ?? 0}</strong><small>outcomes recorded</small></span><span><strong>{weeklySummary?.autonomousActions ?? 0}</strong><small>actions sent without approval</small></span></div></section>
          <div className="owner-control-note"><span>✓</span><div><b>You stay in control.</b><p>Argus prepares decisions and reviewed drafts. It never sends a supplier or customer action without your approval.</p></div></div>
        </section>
      )}

      {screen === "more" && (
        <section className="screen dashboard more-workspace">
          <div className="more-intro"><p className="eyebrow">MORE</p><h1 ref={screenHeadingRef} tabIndex={-1}>Data, unusual activity and decision details</h1><p>Update your files, change the report language, or inspect the evidence behind the latest check.</p><div className="more-shortcuts"><button onClick={() => setScreen("upload")}><span>↻</span><b>Update business data</b><small>Run a new check from fresh CSV exports</small></button><button onClick={() => document.querySelector<HTMLSelectElement>(".language-control select")?.focus()}><span>文</span><b>Change language</b><small>{activeLanguage.nativeName}</small></button></div>{analysis && <details className="more-quality"><summary><span><b>Data quality</b><small>{analysis.quality.validRows.toLocaleString("en-IN")} usable records · {analysis.quality.coverage}% products matched</small></span></summary><div><p>{analysis.quality.rejectedRows} rejected rows and {analysis.quality.duplicates} isolated duplicates.</p>{analysis.quality.warnings.length ? <ul>{analysis.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No data-quality assumption needs attention.</p>}</div></details>}</div>
          <div className="dashboard-head">
            <div><p className="eyebrow">{copy.decisionBrief}</p><h1>{copy.focusActions}</h1><p>Ordered by urgency and likely business impact.</p></div>
            <button className="secondary" onClick={() => setScreen("upload")}>{copy.newAnalysis}</button>
          </div>
          <div className="summary-band">
            <div><span>Safe to spend</span><strong className="green">{money(analysis?.summary.purchasingCapacity ?? runwaySafeBudget)}</strong></div>
            <div><span>Cash protected</span><strong>{money(analysis?.summary.reserve ?? 70000)}</strong></div>
            <div><span>Payments to recover</span><strong className="amber">{money(analysis?.summary.overdueReceivables ?? 136000)}</strong></div>
          </div>
          <section className={`cash-runway ${runway.status.toLowerCase().replace(" ", "-")}`} aria-labelledby="cash-runway-title">
            <div className="runway-head">
              <div><p className="eyebrow">13-WEEK CASH RUNWAY</p><h2 id="cash-runway-title">{runway.shortageWeek ? `Reserve pressure begins in week ${runway.shortageWeek}.` : "Your reserve remains protected."}</h2><span>Conservative view after the proposed purchase. Expected receipts are discounted rather than treated as guaranteed.</span></div>
              <div className="runway-status"><b>{runway.status}</b><small>{runway.confidence} confidence</small></div>
            </div>
            <div className="runway-metrics">
              <div><span>Lowest conservative balance</span><strong>{money(runway.minimumConservativeBalance)}</strong></div>
              <div><span>Reserve gap</span><strong className={runway.cashGap ? "amber" : "green"}>{runway.cashGap ? money(runway.cashGap) : "No gap"}</strong></div>
              <div><span>Expected receipts</span><strong>{money(runway.totalExpectedInflows)}</strong></div>
              <div><span>Outflows + proposed order</span><strong>{money(runway.totalCommittedOutflows)}</strong></div>
            </div>
            <div className="runway-chart" aria-label="Conservative balance by week">
              {runway.weeks.map((week) => <div className={week.conservativeBalance < reserve ? "below" : ""} key={week.week} title={`${week.label}: ${money(week.conservativeBalance)} conservative balance`}><i style={{ height: `${Math.max(7, Math.min(100, Math.max(0, week.conservativeBalance) / runwayMax * 100))}%` }} /><span>W{week.week}</span></div>)}
            </div>
            <details className="runway-details"><summary>See weekly cash drivers and assumptions</summary><div>{runway.weeks.filter((week) => week.expectedInflows || week.committedOutflows || week.proposedPurchases).map((week) => <p key={week.week}><b>Week {week.week}</b><span>{week.driver}</span><strong>{money(week.conservativeBalance)}</strong></p>)}</div><ul>{runway.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details>
          </section>
          {analysis && <section className="cost-intelligence" aria-labelledby="cost-intelligence-title">
            <div className="cost-intelligence-head">
              <div><p className="eyebrow">QUANT ENGINE · COST INTELLIGENCE</p><h2 id="cost-intelligence-title">{analysis.quant.costIntelligence.findings.length ? "Supplier costs need a closer look." : "No material cost pressure detected."}</h2><span>ML finds unusual price and margin patterns. Verified formulas calculate the financial exposure.</span></div>
              <div className="quant-badge"><b>{analysis.quant.costIntelligence.mode === "ml" ? "ML active" : analysis.quant.costIntelligence.mode === "fallback" ? "Fallback" : "Abstained"}</b><small>{analysis.quant.costIntelligence.observations.toLocaleString("en-IN")} cost observations</small></div>
            </div>
            {analysis.quant.costIntelligence.findings[0] ? (() => { const finding = analysis.quant.costIntelligence.findings[0]; return <div className="cost-finding">
              <div><span>Highest margin risk</span><strong>{finding.productName}</strong><small>{finding.supplierName} · {finding.confidence}% confidence</small></div>
              <div><span>Quoted unit cost</span><strong>{money(finding.actualCost)}</strong><small>Expected {money(finding.expectedLower)}–{money(finding.expectedUpper)}</small></div>
              <div><span>30-day margin exposure</span><strong className="amber">{money(finding.marginAtRisk30)}</strong><small>{finding.marginErosionPoints.toFixed(1)} margin points at risk</small></div>
              <button className="text-button" onClick={() => openDetail(actions.find((action) => action.type === "cost_control") ?? actions[2])}>Review evidence →</button>
            </div>; })() : <div className="cost-clear"><span>✓</span><p><strong>Costs are inside the current expected ranges.</strong><small>Argus will still show the model confidence and assumptions below.</small></p></div>}
            <details><summary>How the Quant Engine reached this result</summary><div className="quant-method"><p><b>{analysis.quant.costIntelligence.model}</b><span>Holdout error: {analysis.quant.costIntelligence.holdoutMape === null ? "not available" : `${(analysis.quant.costIntelligence.holdoutMape * 100).toFixed(1)}% MAPE`}</span></p><p><b>{analysis.quant.reliableDemandModelCoverage.toLocaleString("en-IN")} of {analysis.quant.demandModelCoverage.toLocaleString("en-IN")} forecasts validated</b><span>Median backtest error: {analysis.quant.medianDemandWape === null ? "not available" : `${(analysis.quant.medianDemandWape * 100).toFixed(1)}% WAPE`}; unreliable models abstain</span></p><ul>{analysis.quant.costIntelligence.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div></details>
          </section>}
          {analysis && <details className="anomaly-report">
            <summary>
              <span><b>Unusual activity report</b><small>{analysis.anomalies.findings.length ? `${analysis.anomalies.findings.length} pattern${analysis.anomalies.findings.length === 1 ? "" : "s"} need owner verification` : "No material anomalies found"}</small></span>
              <em>{analysis.anomalies.findings.filter((finding) => finding.severity === "Critical" || finding.severity === "High").length} high priority</em>
            </summary>
            <div className="anomaly-report-body">
              <div className="anomaly-report-intro"><p>Argus scanned {analysis.anomalies.scannedRows.toLocaleString("en-IN")} usable rows. A flag means “unusual,” not automatically “wrong.” Verify the business context before changing a forecast or action.</p><span>Report date {analysis.anomalies.reportDate}</span></div>
              {analysis.anomalies.findings.length ? <div className="anomaly-findings">{analysis.anomalies.findings.map((finding) => <article className={`anomaly-finding ${finding.severity.toLowerCase()}`} key={finding.id}>
                <header><div><span>{finding.category}</span><mark className={finding.detectionSource}>{finding.detectionSource === "ml" ? "ML predicted" : "Deterministic rule"}</mark></div><b>{finding.severity} · {finding.confidence}% confidence</b></header>
                <h3>{finding.title}</h3><p>{finding.summary}</p>
                <div className="anomaly-comparison"><span><small>Observed</small><strong>{finding.actual}</strong></span><span><small>Expected</small><strong>{finding.expected}</strong></span></div>
                <p className="anomaly-why"><b>Why it was flagged</b>{finding.whyFlagged}</p>
                <details><summary>View evidence</summary><ul><li className="detection-meta"><strong>Detection source:</strong> {finding.detectionSource === "ml" ? "Machine-learning prediction" : "Verified deterministic rule"}</li><li className="detection-meta"><strong>Method:</strong> {finding.detector}</li>{finding.evidence.map((item) => <li key={item}>{item}</li>)}</ul></details>
                <footer><b>Owner check</b><span>{finding.recommendedCheck}</span></footer>
              </article>)}</div> : <div className="anomaly-empty"><strong>No unusual activity needs verification.</strong><p>Demand, pricing, returns, stock and receivables remained within the current deterministic thresholds.</p></div>}
            </div>
          </details>}
          {localizedReport && <section className="localized-report" aria-live="polite">
            <div className="localized-report-head">
              <div><span>🌐 {activeLanguage.nativeName}</span><h2>{copy.reportTitle}</h2></div>
              <b className={multilingualValidation?.valid ? "verified" : "fallback"}>{multilingualValidation?.valid ? `✓ ${copy.languageVerified}` : "✓ Verified deterministic fallback"}</b>
            </div>
            <p>{localizedReport.summary}</p>
            <small>{localizedReport.riskSummary}</small>
          </section>}
          {languageReportState === "generating" && <div className="localized-report loading" role="status">{copy.preparingReport}</div>}
          <div className="action-list">
            {actions.map((action, index) => (
              <button className={`action-card ${action.type}`} onClick={() => openDetail(action)} key={action.id}>
                <span className="rank">0{index + 1}</span>
                <span className="action-body"><span className="action-meta"><b>{action.urgency}</b> · {action.confidence}%</span><strong>{localizedActions.get(action.type)?.title ?? action.title}</strong><small>{localizedActions.get(action.type)?.reason ?? action.subtitle}</small><em>{localizedActions.get(action.type)?.impact ?? action.impact}</em></span>
                <span className="action-arrow">→</span>
              </button>
            ))}
          </div>
          {analysis && <div className="reasoning-note"><span>{copy.whyMatters}</span><p>{moderatorExplanation ?? copy.preparingReport}</p></div>}
          {selectedLanguage === "en" && <details className="decision-trace">
            <summary><span><b>How Argus reached this result</b><small>Technical checks and specialist perspectives</small></span></summary>
            <div className="agent-panel">
              <div className="agent-grid">
                <article className="agent-view inventory">
                  <header><i />Inventory &amp; Demand</header>
                  <strong>{analysis?.agents.inventory ?? "Calculating required stock"}</strong>
                  <p>Checks demand, available stock, supplier lead time, safety stock and order constraints.</p>
                </article>
                <article className="agent-view cash">
                  <header><i />Cashflow &amp; Collections</header>
                  <strong>{analysis?.agents.cashflow ?? "Calculating affordable quantity"}</strong>
                  <p>Protects the cash reserve while accounting for obligations, receivables and purchase cost.</p>
                </article>
                <article className="agent-view sales">
                  <header><i />Sales Opportunity</header>
                  <strong>{analysis?.agents.sales ?? "Calculating revenue at risk"}</strong>
                  <p>Identifies demand movement and the sales opportunity that available inventory can protect.</p>
                </article>
              </div>
              <div className="moderator-view">
                <span>Final verified resolution</span>
                <strong>{analysis?.agents.moderator ?? "Balance inventory need with available cash"}</strong>
                <p>The moderator combines the three perspectives. Verified code fixes every quantity and amount; the owner approves the action.</p>
              </div>
              <div className="reasoning-source"><i />{reasoningMode === "gemini" ? "Gemini explained the verified decision package; it did not calculate the figures." : reasoningMode === "deterministic-fallback-unverified-output" ? "Gemini output introduced unsupported figures, so Argus rejected it and showed the verified fallback." : reasoningMode === "deterministic-fallback-guardrail" ? "Argus isolated unsafe or malformed AI content and showed the verified deterministic fallback." : reasoningMode === "deterministic-fallback" ? "Gemini is not configured; all verified calculations remain available with a deterministic explanation." : "Gemini could not complete the explanation, so Argus showed the verified deterministic fallback."}</div>
            </div>
          </details>}
          <div className="report-cta">
            <div><span className="report-mark">PDF</span><p><strong>{copy.reportTitle}</strong><small>{copy.reportIntro}</small></p></div>
            {analysis ? <button className="secondary" disabled={snapshotState === "saving" || reportState === "generating" || languageReportState === "generating"} onClick={snapshotState === "error" ? () => void saveAnalysisSnapshot(analysis) : downloadBusinessReport}>{snapshotState === "saving" ? "Saving verified analysis…" : snapshotState === "error" ? "Retry report preparation" : reportState === "generating" ? copy.preparingReport : copy.downloadReport}</button> : <button className="secondary" disabled>Upload data to get report</button>}
            {reportState === "error" && <small role="alert">{copy.reportError}</small>}
          </div>
        </section>
      )}

      {screen === "detail" && (
        <section className="screen detail-screen">
          <button className="back-link" onClick={() => setScreen("actions")}>← Today’s actions</button>
          <div className="detail-grid">
            <div>
              <p className="eyebrow">{selectedAction.urgency.toUpperCase()} · {selectedAction.confidence}% CONFIDENCE</p>
              <h1 ref={screenHeadingRef} tabIndex={-1}>{selectedLocalizedAction?.title ?? selectedAction.title}</h1>
              <p className="lede small">{selectedLocalizedAction?.reason ?? selectedAction.reason}</p>
              <div className="impact-box"><span>Expected business impact</span><strong>{selectedLocalizedAction?.impact ?? selectedAction.impact}</strong></div>
              <details className="evidence-disclosure"><summary>View supporting evidence</summary><ul className="evidence-list">{(selectedLocalizedAction?.evidence ?? selectedAction.evidence).map((item) => <li key={item}><span>✓</span>{item}</li>)}</ul></details>
              {selectedAction.type === "collection" && selectedActionable && (
                <div className="relationship-box">
                  <h3>Respect the relationship</h3>
                  <p>{String(selectedAction.meta?.customerName ?? "This customer")} {selectedAction.meta?.strategic ? "is a strategic customer." : "has an outstanding payment."} Choose the human approach before Argus prepares anything.</p>
                  <div className="tone-options">{[["friendly", "Friendly check-in"], ["payment-date", "Confirm payment date"], ["formal", "Formal reminder"], ["call", "Call personally"]].map(([id, label]) => <button className={tone === id ? "selected" : ""} onClick={() => setTone(id)} key={id}>{label}</button>)}</div>
                </div>
              )}
              <button className="primary wide" disabled={!selectedActionable || approvalState === "saving" || approved} onClick={approveSelectedAction}>{!selectedActionable ? "No approval needed" : approvalState === "saving" ? "Recording approval…" : approved ? "✓ Approved—draft ready" : selectedAction.type === "reorder" ? "Approve purchase-order draft" : selectedAction.type === "collection" ? "Prepare selected follow-up" : selectedAction.type === "cost_control" ? "Approve supplier-cost review" : "Approve purchase pause"}</button>
              {approvalState === "error" && <p role="alert">Approval was not saved. Please try again; no external action occurred.</p>}
              {approved && <div className="approved-panel"><b>Human approval recorded.</b><span>No external action was sent automatically.</span>{selectedAction.type === "collection" && approvalResult?.whatsappDeepLink && <a href={approvalResult.whatsappDeepLink} target="_blank" rel="noreferrer">Open reviewed draft in WhatsApp →</a>}<button onClick={openOutcome}>Record the eventual outcome →</button></div>}
            </div>
            <aside className="simulator"><details>
              <summary><span>Test another scenario</span><small>Adjust budget, reserve or demand</small></summary>
              <div className="simulator-content"><p className="eyebrow">What-if simulator</p><h2>See what changes the decision.</h2>
              {selectedAction.type === "cost_control" ? <>
              <label>Quoted cost assumption <strong>{quotedCostPercent}%</strong><input type="range" min="80" max="130" step="1" value={quotedCostPercent} onInput={(e) => setQuotedCostPercent(Number(e.currentTarget.value))} /></label>
              <label>Target gross margin <strong>{targetMargin}%</strong><input type="range" min="10" max="40" step="1" value={targetMargin} onInput={(e) => setTargetMargin(Number(e.currentTarget.value))} /></label>
              <div className="sim-result"><span>Estimated 30-day margin exposure</span><strong>{money(simulatedMarginExposure)}</strong><small>Minimum selling price for {targetMargin}% margin: {money(simulatedMinimumSellingPrice)}</small><small className="sim-runway">This scenario is deterministic and does not retrain the model.</small></div>
              </> : <><label>Purchase budget <strong>{money(budget)}</strong><input type="range" min="40000" max="160000" step="10000" value={budget} onInput={(e) => setBudget(Number(e.currentTarget.value))} /></label>
              <label>Minimum reserve <strong>{money(reserve)}</strong><input type="range" min="30000" max="100000" step="10000" value={reserve} onInput={(e) => setReserve(Number(e.currentTarget.value))} /></label>
              <label>Supplier lead time <strong>{leadTime} days</strong><input type="range" min="3" max="20" value={leadTime} onInput={(e) => setLeadTime(Number(e.currentTarget.value))} /></label>
              <label>Demand assumption <strong>{demandLift}%</strong><input type="range" min="70" max="140" step="5" value={demandLift} onInput={(e) => setDemandLift(Number(e.currentTarget.value))} /></label>
              <label>Customer payment delay <strong>{paymentDelay} days</strong><input type="range" min="0" max="28" step="7" value={paymentDelay} onInput={(e) => setPaymentDelay(Number(e.currentTarget.value))} /></label>
              <div className="sim-result"><span>Affordable {String(selectedAction.meta?.sku ?? analysis?.reorder.sku ?? "priority SKU")} order</span><strong>{affordableUnits} units</strong><small>{simulation.deferredUnits === 0 ? "Full adjusted requirement can be funded" : `${simulation.deferredUnits} units deferred by budget or cash reserve`}</small><small className="sim-runway">13-week reserve: {runway.cashGap ? `${money(runway.cashGap)} gap in week ${runway.shortageWeek}` : "protected"}</small></div></>}</div>
            </details></aside>
          </div>
        </section>
      )}

      {screen === "outcome" && (
        <section className="screen outcome-screen">
          <p className="eyebrow">CLOSE THE LOOP</p><h1 ref={screenHeadingRef} tabIndex={-1}>What happened after the recommendation?</h1><p className="section-intro">Outcomes—not clicks—make Argus better for your business.</p>
          {outcomeState !== "success" ? <div className="outcome-card outcome-form"><div><strong>Record the verified real-world result</strong><p>Only report value that actually occurred.</p><label>Outcome <select value={outcomeType} onChange={(event) => setOutcomeType(event.target.value)}><option value="stockout_avoided">Stockout risk addressed</option><option value="payment_received">Payment received</option><option value="purchase_avoided">Purchase avoided</option><option value="margin_protected">Margin protected</option><option value="other">Other measured outcome</option></select></label><label>Measured value (₹) <input type="number" min="0" value={outcomeAmount} onChange={(event) => setOutcomeAmount(Number(event.target.value))} /></label><label>What happened? <textarea value={outcomeNotes} onChange={(event) => setOutcomeNotes(event.target.value)} placeholder="Optional evidence or note" /></label><button className="primary" disabled={outcomeState === "saving"} onClick={recordSelectedOutcome}>{outcomeState === "saving" ? "Saving outcome…" : "Save measured outcome"}</button>{outcomeState === "error" && <p role="alert">The outcome was not saved. Try again.</p>}</div></div> : <div className="outcome-card"><span className="success-mark">✓</span><div><strong>Outcome recorded</strong><p>This measured result is now included in the weekly value below.</p></div><time>Just now</time></div>}
          <div className="weekly-value"><p className="eyebrow">THIS WEEK&apos;S MEASURED VALUE</p><div><strong>{weeklySummary?.stockoutRisksAddressed ?? 0}</strong><span>stockout risks addressed</span></div><div><strong>{money(weeklySummary?.measuredValue ?? 0)}</strong><span>recorded value</span></div><div><strong>{weeklySummary?.autonomousActions ?? 0}</strong><span>actions sent without approval</span></div></div>
          <button className="primary" onClick={() => setScreen("reports")}>See measured results →</button>
        </section>
      )}

      {isPrimaryView && analysis && <nav className="mobile-owner-nav" aria-label="Main navigation">{primaryViews.map((item) => <button className={screen === item.id ? "active" : ""} aria-current={screen === item.id ? "page" : undefined} onClick={() => setScreen(item.id)} key={item.id}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>}

      <footer><span>ARGUS · You approve every external action.</span><span>Decision support for Indian MSMEs</span></footer>
    </main>
  );
}
