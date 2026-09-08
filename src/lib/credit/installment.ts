import { calcLoanScheduledAmountExact } from "@/lib/loan-repayment";
import { toStatementMonth } from "@/lib/date-utils";

export type CreditCardInstallmentRateType = "annual_interest" | "period_fee";

export type CreditCardInstallmentScheduleRow = {
  installmentNo: number;
  statementMonth: string;
  date: Date;
  principal: number;
  interest: number;
  payment: number;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function addMonthsUtc(date: Date, offset: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + offset;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date.getUTCDate(), lastDay)));
}

export function buildCreditCardInstallmentSchedule(params: {
  principal: number;
  totalRuns: number;
  rateType: CreditCardInstallmentRateType;
  rate: number;
  billingDay: number;
  firstDate: Date;
}): CreditCardInstallmentScheduleRow[] {
  const principal = roundMoney(params.principal);
  const totalRuns = Math.floor(params.totalRuns);
  const rate = Number(params.rate);
  if (!Number.isFinite(principal) || principal <= 0) throw new Error("分期金额必须大于 0");
  if (!Number.isInteger(totalRuns) || totalRuns < 2 || totalRuns > 120) throw new Error("分期期数应为 2 至 120 期");
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("费率应为 0 至 100");

  const rows: CreditCardInstallmentScheduleRow[] = [];
  const basePrincipal = roundMoney(principal / totalRuns);
  let allocatedPrincipal = 0;
  let remainingPrincipal = principal;
  const exactAnnualPayment = params.rateType === "annual_interest" && rate > 0
    ? calcLoanScheduledAmountExact({
        repaymentMethod: "等额本息",
        annualRate: rate,
        principal,
        totalRuns,
        intervalMonths: 1,
      })
    : null;

  for (let index = 0; index < totalRuns; index += 1) {
    const isLast = index === totalRuns - 1;
    const date = addMonthsUtc(params.firstDate, index);
    let principalPart: number;
    let interest: number;

    if (params.rateType === "annual_interest" && exactAnnualPayment) {
      interest = roundMoney(remainingPrincipal * (rate / 100 / 12));
      principalPart = isLast
        ? roundMoney(remainingPrincipal)
        : roundMoney(Math.min(remainingPrincipal, Math.max(0, exactAnnualPayment - interest)));
      remainingPrincipal = roundMoney(Math.max(0, remainingPrincipal - principalPart));
    } else {
      principalPart = isLast ? roundMoney(principal - allocatedPrincipal) : basePrincipal;
      interest = params.rateType === "period_fee" ? roundMoney(principal * rate / 100) : 0;
    }

    allocatedPrincipal = roundMoney(allocatedPrincipal + principalPart);
    rows.push({
      installmentNo: index + 1,
      statementMonth: toStatementMonth(date, params.billingDay),
      date,
      principal: principalPart,
      interest,
      payment: roundMoney(principalPart + interest),
    });
  }

  return rows;
}

export function summarizeCreditCardInstallments(rows: CreditCardInstallmentScheduleRow[]) {
  const totalPrincipal = roundMoney(rows.reduce((sum, row) => sum + row.principal, 0));
  const totalInterest = roundMoney(rows.reduce((sum, row) => sum + row.interest, 0));
  return {
    totalPrincipal,
    totalInterest,
    totalPayment: roundMoney(totalPrincipal + totalInterest),
    firstPayment: rows[0]?.payment ?? 0,
  };
}
