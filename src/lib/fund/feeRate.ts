import { prisma } from "@/lib/db/prisma";
export type FundFeeRateType = "buy" | "redeem";

export type FundFeeRateReplacementRow = {
  fundCode: string;
  feeType: FundFeeRateType;
  rate: number;
  effectiveDate: Date;
};

/**
 * Query the fund fee rate by confirmation date.
 * Returns the most recent rate whose effective date is <= confirmDate.
 *
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param confirmDate Confirmation date
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 * @returns The fee rate, or the default value 0 when no record exists
 */
export async function getFundFeeRateByDate(
  accountId: string,
  fundCode: string,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<number> {
  const record = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  return record?.rate ? Number(record.rate) : 0;
}

/**
 * Query the latest fund fee rate.
 *
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 * @returns The fee rate (defaults to 0, meaning no fee)
 */
export async function getFundFeeRate(
  accountId: string,
  fundCode: string,
  feeType: FundFeeRateType = "buy"
): Promise<number> {
  const record = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  return record?.rate ? Number(record.rate) : 0;
}

/**
 * Update the fund fee rate (smart mode).
 * 1. Query the most recent rate with effective date <= confirmDate
 * 2. If the value is the same, do not create a new record
 * 3. If the value differs, create a new record dated confirmDate
 * 4. Remove duplicate records after confirmDate that share the same value
 *
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param rate The new rate value
 * @param confirmDate Confirmation date (effective date)
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 */
export async function setFundFeeRateByDate(
  accountId: string,
  fundCode: string,
  rate: number,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  const existingRecord = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  const existingRate = existingRecord?.rate ? Number(existingRecord.rate) : 0;

  if (existingRate === rate) {
    return;
  }

  await prisma.fundFeeRate.create({
    data: {
      accountId,
      fundCode,
      feeType,
      rate,
      effectiveDate: confirmDate,
    },
  });

  const futureRecords = await prisma.fundFeeRate.findMany({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        gt: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "asc",
    },
  });

  for (const record of futureRecords) {
    const recordRate = Number(record.rate);
    if (recordRate === rate) {
      await prisma.fundFeeRate.delete({
        where: { id: record.id },
      });
    }
  }
}

/**
 * Update the fund fee rate inside a transaction.
 * Same logic as setFundFeeRateByDate, but runs within the provided transaction.
 *
 * @param tx Prisma transaction client
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param rate The new rate value
 * @param confirmDate Confirmation date (effective date)
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 */
export async function setFundFeeRateByDateInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  rate: number,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  const existingRecord = await tx.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  const existingRate = existingRecord?.rate ? Number(existingRecord.rate) : 0;

  if (existingRate === rate) {
    return;
  }

  await tx.fundFeeRate.create({
    data: {
      accountId,
      fundCode,
      feeType,
      rate,
      effectiveDate: confirmDate,
    },
  });

  const futureRecords = await tx.fundFeeRate.findMany({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        gt: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "asc",
    },
  });

  for (const record of futureRecords) {
    const recordRate = Number(record.rate);
    if (recordRate === rate) {
      await tx.fundFeeRate.delete({
        where: { id: record.id },
      });
    }
  }
}

/**
 * Update the fund fee rate (for regular investment plans).
 * Uses the current date as the effective date and writes with date-range logic:
 * query the latest rate <= today; skip when equal, create a new record when different.
 *
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param rate The fee rate (can be 0)
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 */
export async function setFundFeeRate(
  accountId: string,
  fundCode: string,
  rate: number,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  await setFundFeeRateByDate(accountId, fundCode, rate, new Date(), feeType);
}

export async function replaceFundFeeRates(
  accountId: string,
  rows: FundFeeRateReplacementRow[],
  fundCode?: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await replaceFundFeeRatesInTx(tx, accountId, rows, fundCode);
  });
}

export async function replaceFundFeeRatesInTx(
  tx: any,
  accountId: string,
  rows: FundFeeRateReplacementRow[],
  fundCode?: string
): Promise<void> {
  const where = fundCode ? { accountId, fundCode } : { accountId };
  await tx.fundFeeRate.deleteMany({ where });
  if (rows.length === 0) return;

  await tx.fundFeeRate.createMany({
    data: rows.map((row) => ({
      accountId,
      fundCode: row.fundCode,
      feeType: row.feeType,
      rate: row.rate,
      effectiveDate: row.effectiveDate,
    })),
  });
}

/**
 * Update the fund fee rate inside a transaction (for regular investment plans).
 * Uses the current date as the effective date and writes with date-range logic.
 *
 * @param tx Prisma transaction client
 * @param accountId Account ID
 * @param fundCode Fund code
 * @param rate The fee rate (can be 0)
 * @param feeType Fee type: buy = purchase fee, redeem = redemption fee
 */
export async function setFundFeeRateInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  rate: number,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  await setFundFeeRateByDateInTx(tx, accountId, fundCode, rate, new Date(), feeType);
}
