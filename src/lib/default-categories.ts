import { AccountKind, Prisma, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { CREDIT_CARD_REPAYMENT_CATEGORY_NAME } from "@/lib/transaction-semantics";
import { FIXED_ASSET_EXPENSE_CATEGORY_NAME } from "@/lib/fixed-asset";
import {
  SYSTEM_DEPOSIT_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_DEPOSIT_INVESTMENT_CATEGORY,
  SYSTEM_FUND_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_FUND_INVESTMENT_CATEGORY,
  SYSTEM_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_INVESTMENT_CATEGORIES,
  SYSTEM_METAL_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_METAL_INVESTMENT_CATEGORY,
  SYSTEM_OTHER_INVESTMENT_CATEGORY,
  SYSTEM_PROPERTY_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_PROPERTY_INVESTMENT_CATEGORY,
  SYSTEM_STOCK_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_STOCK_INVESTMENT_CATEGORY,
  SYSTEM_WEALTH_INVESTMENT_ACTION_CATEGORIES,
  SYSTEM_WEALTH_INVESTMENT_CATEGORY,
  getInvestmentCategoryName,
} from "@/lib/investment-category";

export type DefaultCategoryType = "expense" | "income" | "advance" | "transfer" | "investment";
type CategoryMainType = DefaultCategoryType;

export type DefaultCategoryTemplate = {
  type: DefaultCategoryType;
  name: string;
  isSystem?: boolean;
  children?: Array<string | DefaultCategoryTemplateChild>;
};

type CategoryWriter = typeof prisma | Prisma.TransactionClient;
export const CATEGORY_HIERARCHY_NORMALIZATION_VERSION = "2026-08-21-category-order-and-remove-expense-repayment-v2";
const DELETED_DEFAULT_CATEGORY_KEY_PREFIX = "category_deleted_default_templates:";

type DefaultCategoryTemplateChild = {
  name: string;
  isSystem?: boolean;
  children?: string[];
};

export type CategorySnapshot = {
  id: string;
  name: string;
  type: string;
};

export type ResolveCategorySnapshotInput = {
  categoryId?: string | null;
  categoryName?: string | null;
  type?: DefaultCategoryType | null;
};

export const SYSTEM_FUND_PROFIT_CATEGORY = "基金收益";
export const SYSTEM_FUND_LOSS_CATEGORY = "基金亏损";
export const SYSTEM_WEALTH_PROFIT_CATEGORY = "理财收益";
export const SYSTEM_WEALTH_LOSS_CATEGORY = "理财亏损";
export const SYSTEM_DEPOSIT_INTEREST_CATEGORY = "存款利息";
export const SYSTEM_DEPOSIT_FEE_CATEGORY = "存款手续费";
export const SYSTEM_INVESTMENT_DIVIDEND_CATEGORY = "投资分红";
export const SYSTEM_INVESTMENT_PROFIT_CATEGORY = SYSTEM_FUND_PROFIT_CATEGORY;
export const SYSTEM_INVESTMENT_LOSS_CATEGORY = "投资亏损";
export const SYSTEM_INSURANCE_RETURN_CATEGORY = "保险回款";
export const SYSTEM_INSURANCE_EXPENSE_CATEGORY = "保险支出";
export const SYSTEM_SETTLEMENT_TRANSFER_CATEGORY = "借入借出";
export const SYSTEM_MORTGAGE_FUND_CATEGORY = "资金账户";
export const SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY = "银行分期";

const legacySettlementTransferActionCategoryNames = new Set(["往来款", "还款", "提前还款", "贷款还款", "借入", "借出", "出借", "收回"]);

export function normalizeSettlementTransferCategoryName(categoryName?: string | null) {
  const name = String(categoryName ?? "").trim();
  if (!name || legacySettlementTransferActionCategoryNames.has(name)) return SYSTEM_SETTLEMENT_TRANSFER_CATEGORY;
  return name;
}

const systemCategoryTemplateNames: Record<DefaultCategoryType, Set<string>> = {
  income: new Set([
    "投资收入",
    "投资收益",
    SYSTEM_FUND_PROFIT_CATEGORY,
    "股票收益",
    SYSTEM_WEALTH_PROFIT_CATEGORY,
    SYSTEM_DEPOSIT_INTEREST_CATEGORY,
    SYSTEM_INSURANCE_RETURN_CATEGORY,
    "股息分红",
    SYSTEM_INVESTMENT_DIVIDEND_CATEGORY,
  ]),
  expense: new Set([
    "贷款",
    "贷款本金",
    "贷款利息",
    "贷款手续费",
    SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY,
    FIXED_ASSET_EXPENSE_CATEGORY_NAME,
    SYSTEM_INSURANCE_EXPENSE_CATEGORY,
    SYSTEM_INVESTMENT_LOSS_CATEGORY,
    SYSTEM_FUND_LOSS_CATEGORY,
    SYSTEM_WEALTH_LOSS_CATEGORY,
    SYSTEM_DEPOSIT_FEE_CATEGORY,
    "股票亏损",
  ]),
  advance: new Set(),
  transfer: new Set(["转账", CREDIT_CARD_REPAYMENT_CATEGORY_NAME, SYSTEM_SETTLEMENT_TRANSFER_CATEGORY]),
  investment: new Set(["投资", ...SYSTEM_INVESTMENT_CATEGORIES, ...SYSTEM_INVESTMENT_ACTION_CATEGORIES]),
};

function isSystemCategoryTemplate(type: DefaultCategoryType, name: string) {
  return systemCategoryTemplateNames[type]?.has(name) ?? false;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function resolveCategorySnapshot(
  writer: CategoryWriter,
  householdId: string,
  input: ResolveCategorySnapshotInput,
): Promise<CategorySnapshot | null> {
  const categoryId = String(input.categoryId ?? "").trim();
  const categoryName = String(input.categoryName ?? "").trim();
  const type = input.type ?? null;

  if (categoryId) {
    const category = await writer.category.findFirst({
      where: {
        id: categoryId,
        OR: [{ householdId }, { householdId: null }],
        ...(type ? { type } : {}),
      },
      select: { id: true, name: true, type: true },
    });
    if (category) return category;
  }

  if (!categoryName) return null;

  const category = await writer.category.findFirst({
    where: {
      name: categoryName,
      OR: [{ householdId }, { householdId: null }],
      ...(type ? { type } : {}),
    },
    orderBy: [{ householdId: "desc" }, { id: "asc" }],
    select: { id: true, name: true, type: true },
  });

  return category ?? null;
}

export function resolveCreditCardRepaymentCategory(writer: CategoryWriter, householdId: string) {
  return resolveCategorySnapshot(writer, householdId, {
    categoryName: CREDIT_CARD_REPAYMENT_CATEGORY_NAME,
    type: "transfer",
  });
}

export function resolveSettlementTransferCategory(writer: CategoryWriter, householdId: string) {
  return resolveCategorySnapshot(writer, householdId, {
    categoryName: SYSTEM_SETTLEMENT_TRANSFER_CATEGORY,
    type: "transfer",
  });
}

export async function ensureSettlementTransferCategory(writer: CategoryWriter, householdId: string) {
  const root = await ensureDefaultCategory(writer, householdId, "transfer", "转账", null, true);
  const child = await ensureDefaultCategory(writer, householdId, "transfer", SYSTEM_SETTLEMENT_TRANSFER_CATEGORY, root.id, true);
  return { id: child.id, name: SYSTEM_SETTLEMENT_TRANSFER_CATEGORY, type: "transfer" as const };
}

export async function ensureMortgageFundCategory(writer: CategoryWriter, householdId: string) {
  const root = await ensureDefaultCategory(writer, householdId, "transfer", "转账", null, true);
  const child = await ensureDefaultCategory(writer, householdId, "transfer", SYSTEM_MORTGAGE_FUND_CATEGORY, root.id, true);
  return { id: child.id, name: SYSTEM_MORTGAGE_FUND_CATEGORY, type: "transfer" as const };
}

export async function ensureBankInstallmentExpenseCategory(writer: CategoryWriter, householdId: string) {
  const root = await ensureDefaultCategory(writer, householdId, "expense", "金融保险", null, false);
  const child = await ensureDefaultCategory(writer, householdId, "expense", SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY, root.id, true);
  return { id: child.id, name: SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY, type: "expense" as const };
}

const rootCategoryRenames = [
  { type: "expense", from: "餐饮饮食", to: "餐饮费" },
  { type: "expense", from: "生活日用", to: "生活费" },
  { type: "expense", from: "交通出行", to: "交通费" },
  { type: "expense", from: "购物消费", to: "服饰装饰" },
  { type: "expense", from: "人情社交", to: "人情往来" },
] as const;

const sameNameChildFallback: Record<string, string> = {
  餐饮费: "其他餐饮",
  生活费: "其他生活",
  交通费: "其他交通",
  服饰装饰: "其他服饰",
  人情往来: "其他人情",
};

const categoryTypeLabels: Record<CategoryMainType, string> = {
  expense: "支出",
  income: "收入",
  advance: "代付",
  transfer: "转账",
  investment: "投资",
};

const categoryTypeFallbackNames: Record<CategoryMainType, string> = {
  expense: "其他支出",
  income: "其他收入",
  advance: "其他代付",
  transfer: "其他转账",
  investment: "投资记录",
};

export const defaultCategoryTemplates: DefaultCategoryTemplate[] = [
  {
    type: "expense",
    name: "餐饮费",
    children: ["餐饮美食", "早餐", "午餐", "晚餐", "外卖", "零食饮料", "买菜食材", "水果", "烟酒茶", "聚餐请客"],
  },
  {
    type: "expense",
    name: "生活费",
    children: ["日用百货", "日用品", "清洁用品", "家居用品", "维修维护", "快递物流", "物业杂费", "生活服务"],
  },
  {
    type: "expense",
    name: "交通费",
    children: ["交通出行", "公交地铁", "打车", "火车高铁", "机票", "长途客运", "停车费", "过路费", "加油", "充电", "爱车养车", "保养维修", "车险车税"],
  },
  {
    type: "expense",
    name: "居住住房",
    children: ["住房物业", "房租", "房贷", "物业费", "水费", "电费", "燃气费", "供暖费", "宽带电视", "家居家装", "装修", "家具家电"],
  },
  {
    type: "expense",
    name: FIXED_ASSET_EXPENSE_CATEGORY_NAME,
    isSystem: true,
    children: [],
  },
  {
    type: "expense",
    name: "服饰装饰",
    children: ["服饰装扮", "服饰鞋包", "美妆护肤", "饰品配件", "美容美发", "洗护美发", "家居装饰"],
  },
  {
    type: "expense",
    name: "数码家电",
    children: ["数码电器", "手机电脑", "数码配件", "家用电器", "维修配件"],
  },
  {
    type: "expense",
    name: "医疗健康",
    children: ["挂号门诊", "药品", "体检", "住院", "牙科", "眼科", "保健品", "健身运动"],
  },
  {
    type: "expense",
    name: "教育成长",
    children: ["教育培训", "学费", "培训课程", "考试认证", "书本资料", "文具", "兴趣班", "在线课程"],
  },
  {
    type: "expense",
    name: "子女育儿",
    children: ["母婴亲子", "奶粉尿裤", "玩具", "童装", "托育幼儿园", "课外班", "儿童医疗", "儿童保险"],
  },
  {
    type: "expense",
    name: "人情往来",
    children: ["亲友代付", "人情开支", "红包", "礼金", "请客", "节日礼物", "婚丧嫁娶", "探望慰问"],
  },
  {
    type: "expense",
    name: "通讯网络",
    children: ["充值缴费", "手机话费", "流量套餐", "宽带", "软件会员", "云服务"],
  },
  {
    type: "expense",
    name: "娱乐休闲",
    children: ["文化休闲", "电影演出", "酒店旅游", "旅游", "游戏", "会员订阅", "宠物", "摄影", "棋牌", "酒吧咖啡", "运动户外"],
  },
  {
    type: "expense",
    name: "金融保险",
    children: [SYSTEM_INSURANCE_EXPENSE_CATEGORY, SYSTEM_BANK_INSTALLMENT_EXPENSE_CATEGORY, "保险", "互助保障", "信用借还", "账户存取", "手续费", "利息支出", "信用卡费用"],
  },
  {
    type: "expense",
    name: "贷款",
    children: ["贷款本金", "贷款利息", "贷款手续费"],
  },
  {
    type: "expense",
    name: SYSTEM_INVESTMENT_LOSS_CATEGORY,
    children: [SYSTEM_FUND_LOSS_CATEGORY, SYSTEM_WEALTH_LOSS_CATEGORY, SYSTEM_DEPOSIT_FEE_CATEGORY, "股票亏损"],
  },
  {
    type: "expense",
    name: "赡养公益",
    children: ["赡养老人", "家庭补贴", "公益捐赠", "宗教香火"],
  },
  {
    type: "expense",
    name: "工作经营",
    children: ["商业服务", "办公用品", "差旅", "业务招待", "经营成本", "税费", "设备工具"],
  },
  {
    type: "expense",
    name: "其他支出",
    children: ["其他杂项支出", "公共服务", "临时支出", "未分类支出"],
  },
  {
    type: "income",
    name: "工作收入",
    children: ["工资", "奖金", "津贴补贴", "加班费", "年终奖", "绩效", "兼职收入"],
  },
  {
    type: "income",
    name: "经营收入",
    children: ["营业收入", "服务收入", "佣金提成", "项目收入", "副业收入"],
  },
  {
    type: "income",
    name: "投资收入",
    children: ["投资收益", "利息", "股息分红", SYSTEM_FUND_PROFIT_CATEGORY, "股票收益", SYSTEM_WEALTH_PROFIT_CATEGORY, SYSTEM_DEPOSIT_INTEREST_CATEGORY, SYSTEM_INVESTMENT_DIVIDEND_CATEGORY, "租金收入"],
  },
  {
    type: "income",
    name: SYSTEM_INSURANCE_RETURN_CATEGORY,
    isSystem: true,
    children: [],
  },
  {
    type: "income",
    name: "家庭往来",
    children: ["红包礼金", "家人转入", "朋友转入", "报销", "退款", "退款返现", "借款收回"],
  },
  {
    type: "income",
    name: "福利补助",
    children: ["社保补贴", "公积金", "养老金", "失业金", "生育津贴", "政府补助"],
  },
  {
    type: "income",
    name: "其他收入",
    children: ["意外收入", "未分类收入"],
  },
  {
    type: "advance",
    name: "公司代付",
    children: ["公司差旅费", "公司代购费", "公司其他代付"],
  },
  {
    type: "advance",
    name: "朋友代付",
    children: ["朋友差旅费", "朋友代购费", "朋友其他代付"],
  },
  {
    type: "transfer",
    name: "转账",
    isSystem: true,
    children: [CREDIT_CARD_REPAYMENT_CATEGORY_NAME, SYSTEM_SETTLEMENT_TRANSFER_CATEGORY],
  },
  {
    type: "investment",
    name: "投资",
    isSystem: true,
    children: [
      { name: SYSTEM_FUND_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_FUND_INVESTMENT_ACTION_CATEGORIES] },
      { name: SYSTEM_WEALTH_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_WEALTH_INVESTMENT_ACTION_CATEGORIES] },
      { name: SYSTEM_DEPOSIT_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_DEPOSIT_INVESTMENT_ACTION_CATEGORIES] },
      { name: SYSTEM_METAL_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_METAL_INVESTMENT_ACTION_CATEGORIES] },
      { name: SYSTEM_STOCK_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_STOCK_INVESTMENT_ACTION_CATEGORIES] },
      { name: SYSTEM_PROPERTY_INVESTMENT_CATEGORY, isSystem: true, children: [...SYSTEM_PROPERTY_INVESTMENT_ACTION_CATEGORIES] },
      SYSTEM_OTHER_INVESTMENT_CATEGORY,
    ],
  },
];

export async function createDefaultCategoriesForHousehold(writer: CategoryWriter, householdId: string) {
  for (const category of defaultCategoryTemplates) {
    const parent = await ensureDefaultCategory(
      writer,
      householdId,
      category.type,
      category.name,
      null,
      category.isSystem ?? isSystemCategoryTemplate(category.type, category.name),
    );

    for (const child of category.children ?? []) {
      const childName = typeof child === "string" ? child : child.name;
      const createdChild = await ensureDefaultCategory(
        writer,
        householdId,
        category.type,
        childName,
        parent.id,
        typeof child === "string"
          ? isSystemCategoryTemplate(category.type, childName)
          : child.isSystem ?? isSystemCategoryTemplate(category.type, childName),
      );

      if (typeof child !== "string") {
        for (const grandChildName of child.children ?? []) {
          await ensureDefaultCategory(
            writer,
            householdId,
            category.type,
            grandChildName,
            createdChild.id,
            isSystemCategoryTemplate(category.type, grandChildName),
          );
        }
      }
    }
  }

  await writer.systemSetting.upsert({
    where: { key: categoryNormalizationKey(householdId) },
    update: { value: CATEGORY_HIERARCHY_NORMALIZATION_VERSION },
    create: { key: categoryNormalizationKey(householdId), value: CATEGORY_HIERARCHY_NORMALIZATION_VERSION },
  });
}

export async function normalizeDefaultCategoryHierarchyForHousehold(writer: CategoryWriter, householdId: string) {
  const normalizationKey = categoryNormalizationKey(householdId);
  const marker = await writer.systemSetting.findUnique({
    where: { key: normalizationKey },
    select: { value: true },
  });
  if (marker?.value === CATEGORY_HIERARCHY_NORMALIZATION_VERSION) return;

  await normalizeCategoryTypeLabelNodes(writer, householdId);

  for (const item of rootCategoryRenames) {
    await renameRootCategory(writer, householdId, item.type, item.from, item.to);
  }

  await migrateCreditCardRepaymentCategoryType(writer, householdId);
  await ensureDefaultCategoryTemplatesForHousehold(writer, householdId);
  await removeLegacyExpenseRepaymentCategories(writer, householdId);
  await normalizeCreditCardRepaymentTransferCategories(writer, householdId);
  await normalizeInvestmentTransactionCategories(writer, householdId);

  for (const category of defaultCategoryTemplates) {
    await normalizeSameNameChild(writer, householdId, category.type, category.name);
  }

  await writer.systemSetting.upsert({
    where: { key: normalizationKey },
    update: { value: CATEGORY_HIERARCHY_NORMALIZATION_VERSION },
    create: { key: normalizationKey, value: CATEGORY_HIERARCHY_NORMALIZATION_VERSION },
  });
}

async function removeLegacyExpenseRepaymentCategories(writer: CategoryWriter, householdId: string) {
  for (const name of ["贷款还款", "还款"]) {
    const categories = await writer.category.findMany({
      where: { householdId, type: "expense", name },
      select: { id: true, parentId: true },
    });
    for (const category of categories) {
      await writer.category.updateMany({
        where: { householdId, parentId: category.id },
        data: { parentId: category.parentId },
      });
      await writer.txRecord.updateMany({
        where: { householdId, categoryId: category.id },
        data: { categoryId: null, categoryName: name },
      });
      await writer.category.delete({ where: { id: category.id } });
    }
  }
}

async function normalizeInvestmentTransactionCategories(writer: CategoryWriter, householdId: string) {
  const categories = await writer.category.findMany({
    where: { householdId, type: "investment", name: { in: [...SYSTEM_INVESTMENT_CATEGORIES, ...SYSTEM_INVESTMENT_ACTION_CATEGORIES] } },
    select: { id: true, name: true },
  });
  const categoryByName = new Map(categories.map((category) => [category.name, category]));
  const canAutoClassify: Prisma.TxRecordWhereInput = {
    OR: [
      { categoryId: null },
      { Category: { type: "investment", isSystem: true } },
    ],
  };

  const assignments: Array<{ name: string; where: Prisma.TxRecordWhereInput }> = [
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "buy", source: "regular_invest" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { source: "regular_invest", OR: [
      { fundProductType: { in: ["fund", "money"] }, fundSubtype: { in: ["buy", "regular_invest"] } },
      { fundProductType: null, fundSubtype: { in: ["buy", "regular_invest"] } },
      { fundProductType: { in: ["fund", "money"] }, fundSubtype: null, regularInvestPlanId: { not: null } },
      { fundProductType: null, fundSubtype: null, regularInvestPlanId: { not: null } },
    ] } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "buy_failed", source: "regular_invest_refund" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundSubtype: "buy_failed", source: "regular_invest_refund" } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "buy_failed" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundSubtype: "buy_failed", OR: [{ source: { not: "regular_invest_refund" } }, { source: null }] } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "redeem" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: { in: ["fund", "money"] }, fundSubtype: { in: ["redeem", "switch_out"] } } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "dividend_cash" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: { in: ["fund", "money"] }, fundSubtype: "dividend_cash" } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "dividend_reinvest" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: { in: ["fund", "money"] }, OR: [{ fundSubtype: "dividend_reinvest" }, { fundSubtype: "buy", source: "dividend" }] } },
    { name: getInvestmentCategoryName({ fundProductType: "fund", fundSubtype: "buy" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: { in: ["fund", "money"] }, OR: [
      { fundSubtype: "buy", OR: [{ source: { notIn: ["regular_invest", "dividend"] } }, { source: null }] },
      { fundSubtype: null, OR: [{ source: { notIn: ["regular_invest", "dividend"] } }, { source: null }] },
    ] } },
    { name: getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: "redeem" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "wealth", fundSubtype: { in: ["redeem", "switch_out"] } } },
    { name: getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: "dividend_cash" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "wealth", fundSubtype: "dividend_cash" } },
    { name: getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: "buy" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "wealth", OR: [{ fundSubtype: "buy" }, { fundSubtype: null }] } },
    { name: getInvestmentCategoryName({ fundProductType: "deposit", fundSubtype: "redeem" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "deposit", fundSubtype: { in: ["redeem", "switch_out"] } } },
    { name: getInvestmentCategoryName({ fundProductType: "deposit", fundSubtype: "buy" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "deposit", OR: [{ fundSubtype: "buy" }, { fundSubtype: null }] } },
    { name: getInvestmentCategoryName({ fundProductType: "metal", fundSubtype: "redeem" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "metal", fundSubtype: { in: ["redeem", "switch_out"] } } },
    { name: getInvestmentCategoryName({ fundProductType: "metal", fundSubtype: "buy" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "metal", OR: [{ fundSubtype: "buy" }, { fundSubtype: null }] } },
    { name: getInvestmentCategoryName({ fundProductType: "property", fundSubtype: "redeem" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "property", fundSubtype: { in: ["redeem", "switch_out"] } } },
    { name: getInvestmentCategoryName({ fundProductType: "property", fundSubtype: "buy" }) ?? SYSTEM_OTHER_INVESTMENT_CATEGORY, where: { fundProductType: "property", OR: [{ fundSubtype: "buy" }, { fundSubtype: null }] } },
  ];

  for (const assignment of assignments) {
    const category = categoryByName.get(assignment.name);
    if (!category) continue;
    await writer.txRecord.updateMany({
      where: {
        householdId,
        type: TransactionType.investment,
        deletedAt: null,
        AND: [canAutoClassify, assignment.where],
      },
      data: { categoryId: category.id, categoryName: category.name },
    });
  }
}

async function migrateCreditCardRepaymentCategoryType(writer: CategoryWriter, householdId: string) {
  const categories = await writer.category.findMany({
    where: { householdId, name: CREDIT_CARD_REPAYMENT_CATEGORY_NAME },
    orderBy: [{ type: "asc" }, { id: "asc" }],
    select: { id: true, type: true, parentId: true, isSystem: true },
  });
  if (categories.length === 0) return;

  const target = categories.find((category) => category.type === "transfer") ?? categories[0]!;
  if (target.type !== "transfer" || !target.isSystem) {
    await writer.category.update({
      where: { id: target.id },
      data: { type: "transfer", isSystem: true },
    });
  }

  for (const duplicate of categories) {
    if (duplicate.id === target.id) continue;
    await mergeCategoryInto(writer, householdId, duplicate.id, target.id, CREDIT_CARD_REPAYMENT_CATEGORY_NAME);
  }
}

async function normalizeCreditCardRepaymentTransferCategories(writer: CategoryWriter, householdId: string) {
  const category = await resolveCreditCardRepaymentCategory(writer, householdId);
  if (!category) return;

  await writer.txRecord.updateMany({
    where: {
      householdId,
      type: TransactionType.transfer,
      deletedAt: null,
      account: {
        kind: { in: [AccountKind.cash, AccountKind.bank_debit, AccountKind.ewallet] },
      },
      toAccount: { kind: AccountKind.bank_credit },
    },
    data: {
      categoryId: category.id,
      categoryName: category.name,
    },
  });
}

function categoryNormalizationKey(householdId: string) {
  return `category_hierarchy_normalized:${householdId}`;
}

function deletedDefaultCategoryKey(householdId: string) {
  return `${DELETED_DEFAULT_CATEGORY_KEY_PREFIX}${householdId}`;
}

function defaultCategoryTemplateKey(type: DefaultCategoryType, parentName: string | null, name: string) {
  return JSON.stringify([type, parentName ?? "", name]);
}

function isKnownCategoryType(type: string): type is DefaultCategoryType {
  return ["expense", "income", "advance", "transfer", "investment"].includes(type);
}

function getDeletedDefaultCategorySet(value?: string | null) {
  if (!value) return new Set<string>();
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set<string>();
  }
}

async function getDeletedDefaultCategories(writer: CategoryWriter, householdId: string) {
  const setting = await writer.systemSetting.findUnique({
    where: { key: deletedDefaultCategoryKey(householdId) },
    select: { value: true },
  });
  return getDeletedDefaultCategorySet(setting?.value);
}

function getDefaultCategoryDeletionTemplateKey(input: {
  type: string;
  name: string;
  parentName?: string | null;
  isSystem?: boolean;
}) {
  if (input.isSystem || !isKnownCategoryType(input.type)) return null;
  const type = input.type;
  const name = input.name.trim();
  const parentName = input.parentName?.trim() || null;
  if (!name) return null;

  if (!parentName) {
    const template = defaultCategoryTemplates.find((category) => category.type === type && category.name === name);
    if (!template) return null;
    const isSystem = template.isSystem ?? isSystemCategoryTemplate(type, name);
    return isSystem ? null : defaultCategoryTemplateKey(type, null, name);
  }

  for (const category of defaultCategoryTemplates) {
    if (category.type !== type) continue;
    for (const child of category.children ?? []) {
      const childName = typeof child === "string" ? child : child.name;
      if (category.name === parentName && childName === name) {
        const isSystem = typeof child === "string"
          ? isSystemCategoryTemplate(type, childName)
          : child.isSystem ?? isSystemCategoryTemplate(type, childName);
        return isSystem ? null : defaultCategoryTemplateKey(type, parentName, name);
      }
      if (typeof child !== "string" && child.name === parentName && child.children?.includes(name)) {
        const isSystem = isSystemCategoryTemplate(type, name);
        return isSystem ? null : defaultCategoryTemplateKey(type, parentName, name);
      }
    }
  }

  return null;
}

export async function recordDefaultCategoryDeletion(
  writer: CategoryWriter,
  householdId: string,
  input: { type: string; name: string; parentName?: string | null; isSystem?: boolean },
) {
  const templateKey = getDefaultCategoryDeletionTemplateKey(input);
  if (!templateKey) return;

  const settingKey = deletedDefaultCategoryKey(householdId);
  const current = await writer.systemSetting.findUnique({
    where: { key: settingKey },
    select: { value: true },
  });
  const deleted = getDeletedDefaultCategorySet(current?.value);
  if (deleted.has(templateKey)) return;
  deleted.add(templateKey);

  await writer.systemSetting.upsert({
    where: { key: settingKey },
    update: { value: JSON.stringify([...deleted].sort()) },
    create: { key: settingKey, value: JSON.stringify([...deleted].sort()) },
  });
}

async function normalizeCategoryTypeLabelNodes(writer: CategoryWriter, householdId: string) {
  for (const type of Object.keys(categoryTypeLabels) as CategoryMainType[]) {
    if (type === "transfer" || type === "investment") continue;
    await normalizeCategoryTypeLabelNode(writer, householdId, type);
  }
}

async function normalizeCategoryTypeLabelNode(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
) {
  const label = categoryTypeLabels[type];
  const nodes = await writer.category.findMany({
    where: { householdId, type, name: label },
    select: { id: true, parentId: true },
  });

  for (const node of nodes) {
    await removeCategoryTypeLabelNode(writer, householdId, type, node.id, node.parentId);
  }
}

async function removeCategoryTypeLabelNode(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
  categoryId: string,
  parentId: string | null,
) {
  const children = await writer.category.findMany({
    where: { householdId, parentId: categoryId },
    select: { id: true, name: true },
  });

  for (const child of children) {
    const target = await writer.category.findFirst({
      where: { householdId, type, parentId, name: child.name, NOT: { id: child.id } },
      select: { id: true },
    });

    if (target) {
      await mergeCategoryInto(writer, householdId, child.id, target.id, child.name);
    } else {
      await writer.category.update({ where: { id: child.id }, data: { parentId } });
    }
  }

  if (type === "investment" && parentId === null) {
    await writer.txRecord.updateMany({
      where: { householdId, categoryId },
      data: { categoryId: null, categoryName: null },
    });
  } else {
    const fallbackId = parentId ?? await ensureFallbackCategory(writer, householdId, type);
    const fallbackName = parentId
      ? (await writer.category.findUnique({ where: { id: parentId }, select: { name: true } }))?.name ?? categoryTypeFallbackNames[type]
      : categoryTypeFallbackNames[type];

    await writer.txRecord.updateMany({
      where: { householdId, categoryId },
      data: { categoryId: fallbackId, categoryName: fallbackName },
    });
  }

  await writer.category.deleteMany({ where: { id: categoryId } });
}

async function ensureFallbackCategory(
  writer: CategoryWriter,
  householdId: string,
  type: CategoryMainType,
) {
  const fallbackName = categoryTypeFallbackNames[type];
  let fallback = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: fallbackName },
    select: { id: true },
  });

  // The unique index on Category is (householdId, name), so a restored or
  // imported row can already carry this fallback name under a different
  // parent or type. Reuse it (and converge its type) instead of failing the
  // create with a unique-constraint error.
  if (!fallback) {
    fallback = await writer.category.findFirst({
      where: { householdId, type, name: fallbackName },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  }

  if (!fallback) {
    const anyType = await writer.category.findFirst({
      where: { householdId, name: fallbackName },
      orderBy: { id: "asc" },
      select: { id: true, type: true },
    });
    if (anyType) {
      if (anyType.type !== type) {
        await writer.category.update({ where: { id: anyType.id }, data: { type } });
      }
      fallback = { id: anyType.id };
    }
  }

  if (!fallback) {
    try {
      fallback = await writer.category.create({
        data: { householdId, type, parentId: null, name: fallbackName },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      fallback = await writer.category.findFirst({
        where: { householdId, name: fallbackName },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (!fallback) throw error;
    }
  }

  return fallback.id;
}

async function mergeCategoryInto(
  writer: CategoryWriter,
  householdId: string,
  sourceId: string,
  targetId: string,
  targetName: string,
) {
  await writer.category.updateMany({
    where: { householdId, parentId: sourceId, NOT: { id: targetId } },
    data: { parentId: targetId },
  });
  await writer.txRecord.updateMany({
    where: { householdId, categoryId: sourceId },
    data: { categoryId: targetId, categoryName: targetName },
  });
  await writer.category.deleteMany({ where: { id: sourceId } });
}

async function mergeSameTypeCategoryNameDuplicates(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  name: string,
  targetId: string,
) {
  const duplicates = await writer.category.findMany({
    where: {
      householdId,
      type,
      name,
      NOT: { id: targetId },
    },
    select: { id: true },
  });

  for (const duplicate of duplicates) {
    await mergeCategoryInto(writer, householdId, duplicate.id, targetId, name);
  }
}

async function renameRootCategory(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  from: string,
  to: string,
) {
  const legacy = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: from },
    select: { id: true },
  });
  if (!legacy) return;

  const target = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: to },
    select: { id: true },
  });

  if (!target) {
    await writer.category.update({ where: { id: legacy.id }, data: { name: to } });
    await writer.txRecord.updateMany({ where: { householdId, categoryId: legacy.id }, data: { categoryName: to } });
    return;
  }

  if (target.id === legacy.id) return;

  await writer.category.updateMany({
    where: { householdId, parentId: legacy.id },
    data: { parentId: target.id },
  });
  await writer.txRecord.updateMany({
    where: { householdId, categoryId: legacy.id },
    data: { categoryId: target.id, categoryName: to },
  });
  await writer.category.delete({ where: { id: legacy.id } });
}

async function ensureDefaultCategoryTemplatesForHousehold(writer: CategoryWriter, householdId: string) {
  const deletedDefaults = await getDeletedDefaultCategories(writer, householdId);

  for (const category of defaultCategoryTemplates) {
    const rootIsSystem = category.isSystem ?? isSystemCategoryTemplate(category.type, category.name);
    if (
      !rootIsSystem &&
      deletedDefaults.has(defaultCategoryTemplateKey(category.type, null, category.name))
    ) {
      continue;
    }

    const root = await ensureDefaultCategory(
      writer,
      householdId,
      category.type,
      category.name,
      null,
      rootIsSystem,
    );

    for (const child of category.children ?? []) {
      const childName = typeof child === "string" ? child : child.name;
      const childIsSystem = typeof child === "string"
        ? isSystemCategoryTemplate(category.type, childName)
        : child.isSystem ?? isSystemCategoryTemplate(category.type, childName);
      if (
        !childIsSystem &&
        deletedDefaults.has(defaultCategoryTemplateKey(category.type, category.name, childName))
      ) {
        continue;
      }

      const childRecord = await ensureDefaultCategory(
        writer,
        householdId,
        category.type,
        childName,
        root.id,
        childIsSystem,
      );

      if (typeof child !== "string") {
        for (const grandChildName of child.children ?? []) {
          const grandChildIsSystem = isSystemCategoryTemplate(category.type, grandChildName);
          if (
            !grandChildIsSystem &&
            deletedDefaults.has(defaultCategoryTemplateKey(category.type, childName, grandChildName))
          ) {
            continue;
          }

          await ensureDefaultCategory(
            writer,
            householdId,
            category.type,
            grandChildName,
            childRecord.id,
            grandChildIsSystem,
          );
        }
      }
    }
  }
}

async function ensureDefaultCategory(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  name: string,
  parentId: string | null,
  isSystem: boolean,
) {
  let category = await writer.category.findFirst({
    where: { householdId, type, parentId, name },
    select: { id: true, parentId: true, isSystem: true, type: true },
  });

  if (!category) {
    category = await writer.category.findFirst({
      where: { householdId, type, name },
      orderBy: { id: "asc" },
      select: { id: true, parentId: true, isSystem: true, type: true },
    });
  }

  if (!category && isSystem) {
    category = await writer.category.findFirst({
      where: { householdId, type, name },
      select: { id: true, parentId: true, isSystem: true, type: true },
    });
  }

  if (!category) {
    // The unique index on Category is (householdId, name), so restored or
    // imported data can already contain this name under a different type.
    // Adopt that row and converge its type/parent/system flags instead of
    // attempting a create that would fail with a unique-constraint error and
    // abort category normalization for the whole household (which made the
    // web bootstrap endpoint fail permanently).
    category = await writer.category.findFirst({
      where: { householdId, name },
      orderBy: { id: "asc" },
      select: { id: true, parentId: true, isSystem: true, type: true },
    });
    if (category) {
      const changes: { type?: string; parentId?: string | null; isSystem?: boolean } = {};
      if (category.type !== type) changes.type = type;
      if (category.parentId !== parentId) changes.parentId = parentId;
      if (isSystem && !category.isSystem) changes.isSystem = true;
      if (Object.keys(changes).length > 0) {
        await writer.category.update({ where: { id: category.id }, data: changes });
      }
      await mergeSameTypeCategoryNameDuplicates(writer, householdId, type, name, category.id);
      return { id: category.id };
    }
  }

  if (!category) {
    try {
      const lastSibling = await writer.category.findFirst({
        where: { householdId, type, parentId },
        orderBy: [{ sortOrder: "desc" }, { name: "desc" }, { id: "desc" }],
        select: { sortOrder: true },
      });
      const created = await writer.category.create({
        data: {
          type,
          name,
          parentId,
          householdId,
          isSystem,
          sortOrder: (lastSibling?.sortOrder ?? -1) + 1,
        },
        select: { id: true },
      });
      await mergeSameTypeCategoryNameDuplicates(writer, householdId, type, name, created.id);
      return created;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // A concurrent request may have created the row between our lookups and
      // the create. Re-fetch by name only: the colliding row can have any
      // type (the unique index is (householdId, name)).
      category = await writer.category.findFirst({
        where: { householdId, name },
        orderBy: { id: "asc" },
        select: { id: true, parentId: true, isSystem: true, type: true },
      });
      if (!category) throw error;
    }
  }

  if (category.parentId !== parentId || (isSystem && !category.isSystem) || category.type !== type) {
    await writer.category.update({
      where: { id: category.id },
      data: {
        ...(category.parentId !== parentId ? { parentId } : {}),
        ...(isSystem && !category.isSystem ? { isSystem: true } : {}),
        ...(category.type !== type ? { type } : {}),
      },
    });
  }

  await mergeSameTypeCategoryNameDuplicates(writer, householdId, type, name, category.id);

  return { id: category.id };
}

async function normalizeSameNameChild(
  writer: CategoryWriter,
  householdId: string,
  type: DefaultCategoryType,
  rootName: string,
) {
  const root = await writer.category.findFirst({
    where: { householdId, type, parentId: null, name: rootName },
    select: { id: true },
  });
  if (!root) return;

  const duplicate = await writer.category.findFirst({
    where: { householdId, type, parentId: root.id, name: rootName },
    select: { id: true },
  });
  if (!duplicate) return;

  const [usedCount, childCount] = await Promise.all([
    writer.txRecord.count({ where: { householdId, categoryId: duplicate.id } }),
    writer.category.count({ where: { householdId, parentId: duplicate.id } }),
  ]);

  if (usedCount === 0 && childCount === 0) {
    await writer.category.delete({ where: { id: duplicate.id } });
    return;
  }

  const fallbackName = sameNameChildFallback[rootName] ?? `其他${rootName}`;
  const existingFallback = await writer.category.findFirst({
    where: { householdId, type, parentId: root.id, name: fallbackName },
    select: { id: true },
  });
  if (!existingFallback) {
    await writer.category.update({ where: { id: duplicate.id }, data: { name: fallbackName } });
    await writer.txRecord.updateMany({ where: { householdId, categoryId: duplicate.id }, data: { categoryName: fallbackName } });
  }
}
