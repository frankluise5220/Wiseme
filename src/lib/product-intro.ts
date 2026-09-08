type ProductIntro = {
  title: string;
  mantra: string;
  lead: string;
  paragraphs: string[];
  highlights: string[];
};

export const PRODUCT_INTROS = {
  "zh-CN": { languageLabel: "\u4e2d\u6587" },
  "en-US": { languageLabel: "English" },
  "ja-JP": { languageLabel: "\u65e5\u672c\u8a9e" },
} as const;

type Translate = (key: string) => string;

const PRODUCT_INTRO_PARAGRAPH_KEYS = [
  "productIntro.paragraph1",
  "productIntro.paragraph2",
  "productIntro.paragraph3",
] as const;

const PRODUCT_INTRO_HIGHLIGHT_KEYS = [
  "productIntro.highlight.dailyBookkeeping",
  "productIntro.highlight.accounts",
  "productIntro.highlight.creditCards",
  "productIntro.highlight.funds",
  "productIntro.highlight.stocks",
  "productIntro.highlight.properties",
  "productIntro.highlight.insurance",
  "productIntro.highlight.mortgage",
  "productIntro.highlight.emailAi",
] as const;

export function getProductIntro(t: Translate): ProductIntro {
  return {
    title: t("productIntro.title"),
    mantra: t("productIntro.mantra"),
    lead: t("productIntro.lead"),
    paragraphs: PRODUCT_INTRO_PARAGRAPH_KEYS.map((key) => t(key)),
    highlights: PRODUCT_INTRO_HIGHLIGHT_KEYS.map((key) => t(key)),
  };
}
