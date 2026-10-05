import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, isLanguageConsistent } from "../lib/languages";
import { buildDeterministicLocalizedReport, generateLocalizedReport, validateLocalizedReport } from "../lib/multilingual-report";
import { runReasoningGraph } from "../lib/reasoning-graph";

const decisionPackage = {
  snapshot: { summary: { reserve: 70_000, purchasingCapacity: 50_000 }, cash_runway: { status: "Watch", shortageWeek: null } },
  optimizer: { approvedUnits: 60, leadTime: 10, moq: 20, packageSize: 10 },
  verified_actions: [
    { type: "reorder", title: "Order 60 units of SWITCH-A", reason: "Cash-safe order.", impact: "Protects ₹76,000", confidence: 88, amount: 48_000 },
    { type: "collection", title: "Confirm Sharma payment date", reason: "₹74,000 is overdue.", impact: "Releases cash", confidence: 94, amount: 74_000 },
    { type: "defer", title: "Pause CABLE-B", reason: "Excess stock.", impact: "Retains ₹42,000", confidence: 91, amount: 42_000 },
  ],
};

test("supports exactly the required 12 language codes", () => {
  assert.deepEqual(LANGUAGES.map((language) => language.code), ["en", "hi", "bn", "te", "mr", "ta", "gu", "kn", "ml", "pa", "or", "as"]);
});

test("all 12 deterministic fallbacks preserve locked actions, amounts and language script", () => {
  for (const language of LANGUAGES) {
    const report = buildDeterministicLocalizedReport(decisionPackage, language.code);
    const validation = validateLocalizedReport(report, decisionPackage);
    assert.equal(report.languageCode, language.code);
    assert.equal(report.actions.length, 3);
    assert.deepEqual(report.actions.map((action) => action.amount), [48_000, 74_000, 42_000]);
    assert.equal(isLanguageConsistent([report.title, report.summary, report.ownerControl].join(" "), language.code), true, language.code);
    assert.equal(validation.valid, true, `${language.code}: ${JSON.stringify(validation)}`);
  }
});

test("a language-aware provider receives the structured package and produces Tamil output", async () => {
  let attempts = 0;
  const result = await generateLocalizedReport(decisionPackage, "ta", async ({ languageCode, decisionPackage: supplied }) => {
    attempts += 1;
    assert.equal(languageCode, "ta");
    assert.deepEqual(supplied.verified_actions, decisionPackage.verified_actions);
    return {
      title: "சரிபார்க்கப்பட்ட வணிக முடிவு அறிக்கை",
      summary: "வணிகத் தரவிலிருந்து பணப் பாதுகாப்புடன் மூன்று முன்னுரிமைகள் உருவாக்கப்பட்டுள்ளன.",
      riskSummary: "உரிமையாளர் பணப்பாதை மற்றும் ஆதாரங்களைச் சரிபார்த்த பிறகே நடவடிக்கை எடுக்க வேண்டும்.",
      methodology: "கட்டமைக்கப்பட்ட உண்மைகள் மாறாமல் வைக்கப்பட்டு தேர்ந்தெடுத்த மொழியில் அறிக்கை நேரடியாக உருவாக்கப்படுகிறது.",
      warnings: ["உண்மையான இருப்பையும் வாடிக்கையாளர் சூழலையும் உறுதிப்படுத்தவும்."],
      actions: [
        { type: "reorder", title: "SWITCH-A மறுஆர்டரை மதிப்பாய்வு செய்க", reason: "பண இருப்பைக் காக்கும் வரம்பில் பரிந்துரை அமைந்துள்ளது.", impact: "அருகாமைக் கிடைப்பை பாதுகாக்க உதவும்.", evidence: ["தொகையும் நம்பிக்கையும் கட்டமைக்கப்பட்ட தரவில் பூட்டப்பட்டுள்ளன."] },
        { type: "collection", title: "Sharma பணத் தேதியை உறுதிப்படுத்துக", reason: "உறவை மதிக்கும் உரிமையாளர் முடிவு அவசியம்.", impact: "தானியக்க செய்தியின்றி பணத்தை மீட்க உதவும்.", evidence: ["வாடிக்கையாளர் சூழல் உரிமையாளர் மதிப்பாய்வுக்காக வைக்கப்பட்டுள்ளது."] },
        { type: "defer", title: "CABLE-B வாங்குதலை இடைநிறுத்துக", reason: "மெதுவான இருப்பில் பணம் முடங்குவதை தவிர்க்கிறது.", impact: "அதிக முன்னுரிமை தேவைக்கு பணத்தை வைத்திருக்க உதவும்.", evidence: ["செயல் வகையும் வரிசையும் சரிபார்க்கப்பட்டுள்ளன."] },
      ],
    };
  });
  assert.equal(attempts, 1);
  assert.equal(result.mode, "gemini");
  assert.equal(result.validation.valid, true);
  assert.equal(isLanguageConsistent(result.report.summary, "ta"), true);
});

test("invalid multilingual numbers are retried and then replaced by the verified fallback", async () => {
  let attempts = 0;
  const result = await generateLocalizedReport(decisionPackage, "hi", async () => {
    attempts += 1;
    return {
      title: "सत्यापित व्यावसायिक रिपोर्ट",
      summary: "नई असमर्थित राशि 999999 जोड़कर तीन निर्णय तैयार किए गए हैं।",
      riskSummary: "कार्रवाई से पहले सभी प्रमाण जाँचें।",
      methodology: "सत्यापित डेटा से संरचित रिपोर्ट बनाई गई है।",
      warnings: ["भौतिक स्टॉक जाँचें।"],
      actions: decisionPackage.verified_actions.map((action) => ({ type: action.type, title: "सत्यापित कार्रवाई देखें", reason: "प्रमाण की समीक्षा आवश्यक है।", impact: "मालिक निर्णय लेगा।", evidence: ["सत्यापित रिकॉर्ड उपलब्ध है।"] })),
    };
  });
  assert.equal(attempts, 2);
  assert.equal(result.mode, "deterministic-fallback-guardrail");
  assert.doesNotMatch(result.report.summary, /999999/);
  assert.equal(result.validation.valid, true);
});

test("LangGraph returns the final explanation and report in the selected language", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await runReasoningGraph(decisionPackage, { languageCode: "kn" });
    assert.equal(result.languageCode, "kn");
    assert.equal(isLanguageConsistent(result.explanation, "kn"), true);
    assert.equal(result.localizedReport.actions.length, 3);
    assert.equal(result.multilingualValidation.valid, true);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
