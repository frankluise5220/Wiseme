import { Prisma } from "@prisma/client";
import type { ParsedItem } from "@/lib/ai/parser";
import {
  alignStatementIncomeRefunds,
  alignStatementRecognitionToLedger,
  enrichKnownStatementMerchantForImport,
} from "@/lib/statement/import-normalization";
import { loadStatementRecognitionRuleSamples } from "@/lib/statement/recognition-rules";

type AiImportClient = {
  category: {
    findMany(args: {
      where?: Record<string, unknown>;
      select: { id: true; type: true; name: true };
    }): Promise<Array<{ id: string; type: string; name: string }>>;
  };
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

function stripAiRecognitionHints(item: ParsedItem): ParsedItem {
  if (item.type === "investment") return item;
  return {
    ...item,
    category: undefined,
    categoryId: undefined,
    institution: undefined,
    institutionId: undefined,
  };
}

export async function enrichAiParsedItems(
  client: AiImportClient,
  householdId: string,
  hidFilter: Record<string, string>,
  items: ParsedItem[],
) {
  const categories = await client.category.findMany({
    where: hidFilter,
    select: { id: true, type: true, name: true },
  });
  const recognitionSamples = await loadStatementRecognitionRuleSamples(client, householdId);
  const strippedItems = items.map(stripAiRecognitionHints);
  const merchantEnriched = strippedItems.map(enrichKnownStatementMerchantForImport);
  const refundAligned = alignStatementIncomeRefunds(merchantEnriched);
  return alignStatementRecognitionToLedger(refundAligned, categories, recognitionSamples);
}
