import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { findInstitutionDisplayNameConflict } from "@/lib/server/institution-name-unique";
import { defaultFundCompanyNames } from "@/lib/default-fund-companies";

export type DefaultInstitutionType = "bank" | "insurance" | "brokerage" | "fund_company" | "payment" | "debt" | "other";

export type DefaultInstitutionTemplate = {
  name: string;
  type: DefaultInstitutionType;
};

type InstitutionWriter = typeof prisma | Prisma.TransactionClient;

export const defaultInstitutionTemplates: DefaultInstitutionTemplate[] = [
  { name: "支付宝", type: "payment" },
  { name: "微信支付", type: "payment" },
  { name: "银联", type: "payment" },
  { name: "云闪付", type: "payment" },
  { name: "京东", type: "payment" },
  { name: "京东金融", type: "payment" },
  { name: "美团金融", type: "payment" },
  { name: "抖音支付", type: "payment" },
  { name: "工商银行", type: "bank" },
  { name: "农业银行", type: "bank" },
  { name: "中国银行", type: "bank" },
  { name: "建设银行", type: "bank" },
  { name: "交通银行", type: "bank" },
  { name: "招商银行", type: "bank" },
  { name: "邮储银行", type: "bank" },
  { name: "中信银行", type: "bank" },
  { name: "光大银行", type: "bank" },
  { name: "华夏银行", type: "bank" },
  { name: "民生银行", type: "bank" },
  { name: "浦发银行", type: "bank" },
  { name: "兴业银行", type: "bank" },
  { name: "广发银行", type: "bank" },
  { name: "平安银行", type: "bank" },
  { name: "北京银行", type: "bank" },
  { name: "上海银行", type: "bank" },
  { name: "农商银行", type: "bank" },
  { name: "证券账户", type: "brokerage" },
  // 全国公募基金管理公司（fund_company 类型默认值）
  ...defaultFundCompanyNames.map((name) => ({ name, type: "fund_company" as const })),
];

export async function createDefaultInstitutionsForHousehold(writer: InstitutionWriter, householdId: string) {
  for (const institution of defaultInstitutionTemplates) {
    const conflict = await findInstitutionDisplayNameConflict(writer, {
      householdId,
      name: institution.name,
    });
    if (conflict) continue;
    await writer.institution.create({
      data: {
        name: institution.name,
        type: institution.type,
        householdId,
      },
    });
  }
}
