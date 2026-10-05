export const LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English", locale: "en-IN", fontFile: null },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", locale: "hi-IN", fontFile: "NotoSansDevanagari-Regular.ttf" },
  { code: "bn", nativeName: "বাংলা", englishName: "Bengali", locale: "bn-IN", fontFile: "NotoSansBengali-Regular.ttf" },
  { code: "te", nativeName: "తెలుగు", englishName: "Telugu", locale: "te-IN", fontFile: "NotoSansTelugu-Regular.ttf" },
  { code: "mr", nativeName: "मराठी", englishName: "Marathi", locale: "mr-IN", fontFile: "NotoSansDevanagari-Regular.ttf" },
  { code: "ta", nativeName: "தமிழ்", englishName: "Tamil", locale: "ta-IN", fontFile: "NotoSansTamil-Regular.ttf" },
  { code: "gu", nativeName: "ગુજરાતી", englishName: "Gujarati", locale: "gu-IN", fontFile: "NotoSansGujarati-Regular.ttf" },
  { code: "kn", nativeName: "ಕನ್ನಡ", englishName: "Kannada", locale: "kn-IN", fontFile: "NotoSansKannada-Regular.ttf" },
  { code: "ml", nativeName: "മലയാളം", englishName: "Malayalam", locale: "ml-IN", fontFile: "NotoSansMalayalam-Regular.ttf" },
  { code: "pa", nativeName: "ਪੰਜਾਬੀ", englishName: "Punjabi", locale: "pa-IN", fontFile: "NotoSansGurmukhi-Regular.ttf" },
  { code: "or", nativeName: "ଓଡ଼ିଆ", englishName: "Odia", locale: "or-IN", fontFile: "NotoSansOriya-Regular.ttf" },
  { code: "as", nativeName: "অসমীয়া", englishName: "Assamese", locale: "as-IN", fontFile: "NotoSansBengali-Regular.ttf" },
] as const;

export type LanguageCode = typeof LANGUAGES[number]["code"];
export type LanguageDefinition = typeof LANGUAGES[number];

export const DEFAULT_LANGUAGE: LanguageCode = "en";
export const LANGUAGE_STORAGE_KEY = "argus.selectedLanguage";

const codes = new Set<string>(LANGUAGES.map((language) => language.code));
const scriptPatterns: Record<LanguageCode, RegExp> = {
  en: /[A-Za-z]/g,
  hi: /[\u0900-\u097F]/g,
  bn: /[\u0980-\u09FF]/g,
  te: /[\u0C00-\u0C7F]/g,
  mr: /[\u0900-\u097F]/g,
  ta: /[\u0B80-\u0BFF]/g,
  gu: /[\u0A80-\u0AFF]/g,
  kn: /[\u0C80-\u0CFF]/g,
  ml: /[\u0D00-\u0D7F]/g,
  pa: /[\u0A00-\u0A7F]/g,
  or: /[\u0B00-\u0B7F]/g,
  as: /[\u0980-\u09FF]/g,
};

export function normalizeLanguageCode(value: unknown): LanguageCode {
  const candidate = String(value ?? "").trim().toLowerCase();
  return codes.has(candidate) ? candidate as LanguageCode : DEFAULT_LANGUAGE;
}

export function getLanguage(code: LanguageCode): LanguageDefinition {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0];
}

export function languageLabel(code: LanguageCode) {
  const language = getLanguage(code);
  return `${language.nativeName} — ${language.englishName}`;
}

export function formatIndianCurrency(value: number, code: LanguageCode = DEFAULT_LANGUAGE) {
  return new Intl.NumberFormat(getLanguage(code).locale, {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function isLanguageConsistent(text: string, code: LanguageCode) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const target = text.match(scriptPatterns[code]) ?? [];
  // Proper nouns, SKUs and unavoidable technical terms may stay Latin.
  return target.length >= 4 && target.length / letters.length >= (code === "en" ? 0.72 : 0.42);
}

