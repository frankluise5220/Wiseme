type MerchantSource = {
  institution?: string | null;
  counterparty?: string | null;
  remark?: string | null;
  rawText?: string | null;
};

type MerchantRule = {
  pattern: RegExp;
  counterparty: string;
  category?: string;
  institution?: string;
};

const MERCHANT_RULES: MerchantRule[] = [
  { pattern: /\u7279\u6765\u7535|\u5145\u7535\u9884\u5145\u503c|\u5145\u7535\u6869|\u5145\u7535\u7ad9|\u65b0\u80fd\u6e90.*\u5145\u7535/, counterparty: "\u5145\u7535\u670d\u52a1", category: "\u5145\u7535" },
  { pattern: /江苏云快充|云快充|新能源.*充电|充电桩/, counterparty: "江苏云快充新能源科技有限公司", category: "充电" },
  { pattern: /支付宝[^-]*-?(.*)/, counterparty: "支付宝", institution: "支付宝", category: "购物" },
  { pattern: /财付通[^-]*-?(.*)/, counterparty: "微信支付", institution: "微信", category: "购物" },
  { pattern: /微信支付/, counterparty: "微信支付", institution: "微信", category: "购物" },
  { pattern: /美团外卖/, counterparty: "美团外卖", institution: "美团", category: "餐饮" },
  { pattern: /(?:特约)?美团(?:平台)?商户?|美团/, counterparty: "美团", institution: "美团", category: "餐饮" },
  { pattern: /大众点评/, counterparty: "大众点评", institution: "大众点评", category: "餐饮" },
  { pattern: /饿了么/, counterparty: "饿了么", institution: "饿了么", category: "餐饮" },
  { pattern: /携程/, counterparty: "携程", institution: "携程", category: "旅游" },
  { pattern: /滴滴出行|打车/, counterparty: "滴滴出行", institution: "滴滴出行", category: "交通" },
  { pattern: /地铁|公交/, counterparty: "公共交通", category: "交通" },
  { pattern: /中国铁路|铁路网络|12306|火车票|高铁票|铁路/, counterparty: "中国铁路", institution: "中国铁路", category: "火车高铁" },
  { pattern: /\u4e2d\u56fd\u77f3\u5316|\u4e2d\u77f3\u5316/, counterparty: "\u4e2d\u56fd\u77f3\u5316", institution: "\u4e2d\u56fd\u77f3\u5316" },
  { pattern: /停车场|停车费|停车/, counterparty: "停车场", category: "停车费" },
  { pattern: /移动|联通|电信/, counterparty: "运营商", category: "通讯" },
  { pattern: /拼多多|付费通/, counterparty: "拼多多", institution: "拼多多", category: "购物" },
  { pattern: /(水费|电费|水电费|燃气费|天然气|暖气费|供水|供电|供气|自来水|燃气公司|电力公司)/, counterparty: "水电燃气", category: "生活缴费" },
  { pattern: /(物业|管理费)/, counterparty: "物业", category: "居住" },
  { pattern: /京东(到家)?|网银在线/, counterparty: "京东", institution: "京东", category: "购物" },
  { pattern: /天猫|淘宝/, counterparty: "淘宝/天猫", institution: "淘宝/天猫", category: "购物" },
  { pattern: /盒马/, counterparty: "盒马鲜生", institution: "盒马鲜生", category: "餐饮" },
  { pattern: /(永辉|沃尔玛|家乐福|大润发)/, counterparty: "超市", category: "购物" },
  { pattern: /(顺丰|圆通|中通|韵达|申通|邮政)/, counterparty: "快递", category: "购物" },
  { pattern: /(医保|社保|药店)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(医院|诊所|挂号)/, counterparty: "医疗", category: "医疗" },
  { pattern: /(学费|培训|教育)/, counterparty: "教育", category: "教育" },
  { pattern: /(会员|订阅|自动续费)/, counterparty: "会员", category: "娱乐" },
  { pattern: /(爱奇艺|腾讯视频|优酷|哔哩)/, counterparty: "视频会员", category: "娱乐" },
  { pattern: /嘟嘟抓饭|抓饭/, counterparty: "嘟嘟抓饭", category: "餐饮" },
  { pattern: /食品|生鲜|粮油|零食/, counterparty: "食品", category: "食品" },
  { pattern: /(星巴克|瑞幸|喜茶|奈雪)/, counterparty: "咖啡茶饮", category: "餐饮" },
  { pattern: /(麦当劳|肯德基|汉堡王)/, counterparty: "快餐", category: "餐饮" },
  { pattern: /云闪付/, counterparty: "云闪付", institution: "云闪付" },
];

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanOptionalText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? undefined : text;
}

function stripPostingDateNote(value: string) {
  return value
    .replace(/[（(]\s*入账日(?:期)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}\s*[)）]/g, "")
    .trim();
}

function cleanupMerchantName(value: string) {
  return value
    .replace(/^[-—\s]+/, "")
    .replace(/[（(]\s*入账日(?:期)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}\s*[)）]/g, "")
    .replace(/[（(]\s*特约\s*[)）]/g, "")
    .replace(/^(快捷|平台商户|商户)+[-—\s]*/, "")
    .replace(/^支付[-—\s]+/, "")
    .trim();
}

function extractMerchant(text: string) {
  const split = text.split(/--|－|—/).map((item) => item.trim()).filter(Boolean);
  if (split.length >= 2) return cleanupMerchantName(split.slice(1).join("-"));
  const jd = text.match(/京东支付[-—]?(.+)/);
  if (jd?.[1]) return cleanupMerchantName(jd[1]);
  return "";
}

function extractLabeledMerchant(text: string) {
  const labeledMerchant = text.match(/(?:^|[\s/])\u5546\u6237[:\uff1a]\s*([^/]+?)(?=\s*\/|$)/);
  return cleanupMerchantName(labeledMerchant?.[1] ?? "");
}

function extractPaymentPrefix(text: string) {
  return cleanupMerchantName(text.split(/--|－|—/)[0] ?? "");
}

function inferInstitutionFromPrefix(text: string) {
  const prefix = extractPaymentPrefix(text);
  if (/拼多多|付费通/.test(prefix)) return "拼多多";
  if (/支付宝/.test(prefix)) return "支付宝";
  if (/财付通|微信支付|微信/.test(prefix)) return "微信";
  if (/京东|网银在线/.test(prefix)) return "京东";
  if (/美团/.test(prefix)) return "美团";
  if (/云闪付|银联/.test(prefix)) return "银联";
  if (/淘宝|天猫/.test(prefix)) return "淘宝/天猫";
  return "";
}

function inferCategoryFromRemark(text: string) {
  const remark = cleanupMerchantName(extractMerchant(text) || text);
  if (!remark) return "";
  if (/国网|国家电网|电力|电费|水费|水电费|燃气费|天然气|暖气费|供水|供电|供气|自来水|燃气公司|电力公司/.test(remark)) return "水电燃气";
  if (/年费|账户管理费|银行卡费|信用卡费|制卡费|手续费/.test(remark)) return "银行费用";
  if (/嘟嘟抓饭|抓饭|外卖|餐饮|饭店|餐厅|食堂|小吃|火锅|烧烤|咖啡|茶饮|奶茶|美食/.test(remark)) return "餐饮";
  if (/快递|顺丰|圆通|中通|韵达|申通|邮政|取件|寄件/.test(remark)) return "快递";
  if (/停车场|停车费|停车/.test(remark)) return "停车费";
  if (/中国铁路|铁路网络|12306|火车票|高铁票|铁路/.test(remark)) return "火车高铁";
  if (/江苏云快充|云快充|新能源.*充电|充电桩|充电站/.test(remark)) return "充电";
  if (/食品|生鲜|粮油|零食|食材|水果|蔬菜|肉类|熟食/.test(remark)) return "食品";
  if (/车品|汽车用品|汽配|轮胎|机油|洗车|加油|ETC/.test(remark)) return "车品";
  if (/数码|电子|电脑|手机|通讯器材|电器|配件|电工/.test(remark)) return "数码";
  return "";
}

export function inferKnownStatementMerchant(item: MerchantSource) {
  const source = [item.institution, item.counterparty, item.remark, item.rawText]
    .map((value) => cleanOptionalText(value))
    .filter(Boolean)
    .join(" ");
  const normalizedSource = stripPostingDateNote(source);
  const normalizedText = cleanupMerchantName(normalizedSource).replace(/特约商户?/g, "").trim();
  const prefixInstitution = inferInstitutionFromPrefix(normalizedText);
  const remarkCategory = inferCategoryFromRemark(normalizedText);
  const labeledMerchant = extractLabeledMerchant(source);
  for (const { pattern, counterparty, category, institution } of MERCHANT_RULES) {
    const matchText = pattern.test(normalizedText) ? normalizedText : source;
    if (!pattern.test(matchText)) continue;
    const extra = cleanupMerchantName(extractMerchant(matchText));
    if (counterparty === "\u652f\u4ed8\u5b9d" && (labeledMerchant || !extra)) continue;
    const broadPlatformCategory = counterparty === "\u652f\u4ed8\u5b9d" ? undefined : category;
    return {
      counterparty: extra || labeledMerchant || counterparty,
      category: remarkCategory || broadPlatformCategory || undefined,
      institution: prefixInstitution || institution || counterparty,
    };
  }
  return {
    counterparty: labeledMerchant || undefined,
    category: remarkCategory || undefined,
    institution: prefixInstitution || undefined,
  };
}
