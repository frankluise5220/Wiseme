"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { formatMoneyYuan, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

export type MobileInvestmentFundEntry = {
  id: string;
  date: string;
  subtype: string;
  source: string;
  amount: number;
  nav: number | null;
  units: number | null;
  fee: number;
  realizedProfit: number | null;
};

export type MobileInvestmentFundChartPoint = {
  date: string;
  nav: number;
  cumNav: number | null;
};

export type MobileInvestmentFundPosition = {
  fundCode: string;
  fundName: string;
  units: number;
  avgCost: number;
  cost: number;
  pendingCost: number;
  nav: number | null;
  marketValue: number;
  floatingPnL: number;
  floatingRate: number;
  historicalProfit: number;
  entries: MobileInvestmentFundEntry[];
  chart: MobileInvestmentFundChartPoint[];
};

export type MobileInvestmentClearedPosition = {
  fundCode: string;
  fundName: string;
  buyAmount: number;
  redeemAmount: number;
  historicalProfit: number;
  returnRate: number;
  firstDate: string;
  clearedDate: string;
  entries: MobileInvestmentFundEntry[];
  chart: MobileInvestmentFundChartPoint[];
};

export type MobileInvestmentAccountDetail = {
  accountId: string;
  holdings: MobileInvestmentFundPosition[];
  cleared: MobileInvestmentClearedPosition[];
};

type InvestmentRow = {
  id: string;
  label: string;
  hoverTitle?: string;
  productType: string;
  marketValue: number;
  totalCost: number;
  floatingPnL: number;
  floatingRate: number;
  href: string;
};

export function MobileInvestments({
  rows,
  details,
  total,
  totalCost,
  totalFloatingPnL,
  isRedUp,
}: {
  rows: InvestmentRow[];
  details: MobileInvestmentAccountDetail[];
  total: number;
  totalCost: number;
  totalFloatingPnL: number;
  isRedUp: boolean;
}) {
  const { t } = useI18n();
  const valueClass = (value: number) => pnlClassFromRedUp(value, isRedUp, "softDark");
  const [selectedAccountId, setSelectedAccountId] = useState(rows[0]?.id ?? "");
  const [selectedFundKey, setSelectedFundKey] = useState("");
  const [showTransactions, setShowTransactions] = useState(false);

  const detailMap = useMemo(() => new Map(details.map((detail) => [detail.accountId, detail])), [details]);
  const selectedAccount = rows.find((row) => row.id === selectedAccountId) ?? rows[0] ?? null;
  const selectedDetail = selectedAccount ? detailMap.get(selectedAccount.id) : undefined;
  const fundOptions = useMemo(() => {
    if (!selectedDetail) return [];
    return [
      ...selectedDetail.holdings.map((fund) => ({ key: `holding:${fund.fundCode}`, kind: "holding" as const, fund })),
      ...selectedDetail.cleared.map((fund) => ({ key: `cleared:${fund.fundCode}`, kind: "cleared" as const, fund })),
    ];
  }, [selectedDetail]);
  const selectedFund = fundOptions.find((item) => item.key === selectedFundKey) ?? fundOptions[0];

  function selectAccount(accountId: string) {
    setSelectedAccountId(accountId);
    setSelectedFundKey("");
    setShowTransactions(false);
  }

  function selectFund(key: string) {
    setSelectedFundKey(key);
    setShowTransactions(false);
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-slate-200 bg-slate-50/96 px-2 backdrop-blur">
        <MobileTab href="/investments" label={t("overview.investmentOverview")} active />
        <MobileTab href="/regular-invest" label={t("mobileInvestments.regularInvest")} />
      </div>

      <div className="space-y-2.5 px-3 py-2 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">{t("mobileInvestments.totalMarketValue")}</div>
          <div className="mt-1 break-all text-[26px] font-bold text-white tabular-nums">{formatMoneyYuan(total)}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/15 pt-3">
            <div>
              <div className="text-[11px] text-indigo-200">{t("overview.holdingCost")}</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-white tabular-nums">{formatMoneyYuan(totalCost)}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-indigo-200">{t("overview.floatingPnL")}</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-white tabular-nums">{formatMoneyYuan(totalFloatingPnL)}</div>
            </div>
          </div>
        </section>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">{t("invest.noAccounts")}</div>
        ) : (
          <>
            <section className="space-y-2">
              <div className="px-1 text-xs font-semibold text-slate-500">{t("mobileInvestments.accountCards")}</div>
              {rows.map((row) => {
                const active = row.id === selectedAccount?.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    title={row.hoverTitle}
                    onClick={() => selectAccount(row.id)}
                    className={`w-full rounded-lg border bg-white px-3 py-3 text-left shadow-sm transition ${active ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-200"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">{row.label}</div>
                        <div className="mt-1 text-[11px] text-slate-400">{row.productType}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[11px] text-slate-400">{t("investments.marketValue")}</div>
                        <div className="text-sm font-semibold tabular-nums text-slate-800">{formatMoneyYuan(row.marketValue)}</div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-2 text-xs">
                      <Metric label={t("mobileInvestments.cost")} value={formatMoneyYuan(row.totalCost)} />
                      <Metric label={t("overview.floatingPnL")} value={formatMoneyYuan(row.floatingPnL)} valueClassName={valueClass(row.floatingPnL)} />
                      <Metric label={t("invest.floatingRate")} value={formatPercent(row.floatingRate)} valueClassName={valueClass(row.floatingRate)} alignRight />
                    </div>
                  </button>
                );
              })}
            </section>

            {selectedAccount ? (
              <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-800">{selectedAccount.label}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{t("mobileInvestments.accountDetailHint")}</div>
                  </div>
                  <Link href={selectedAccount.href} className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                    {t("mobileInvestments.fullWorkspace")}
                  </Link>
                </div>

                {!selectedDetail || fundOptions.length === 0 ? (
                  <div className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                    {t("mobileInvestments.noFundDetail")}
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <FundList
                      title={t("mobileInvestments.holdings")}
                      funds={selectedDetail.holdings}
                      activeKey={selectedFund?.key ?? ""}
                      prefix="holding"
                      valueClass={valueClass}
                      onSelect={selectFund}
                    />
                    <FundList
                      title={t("mobileInvestments.cleared")}
                      funds={selectedDetail.cleared}
                      activeKey={selectedFund?.key ?? ""}
                      prefix="cleared"
                      valueClass={valueClass}
                      onSelect={selectFund}
                      cleared
                    />
                    {selectedFund ? (
                      <FundDetailPanel
                        item={selectedFund}
                        showTransactions={showTransactions}
                        valueClass={valueClass}
                        onToggleTransactions={() => setShowTransactions((value) => !value)}
                      />
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function MobileTab({ href, label, active = false }: { href: string; label: string; active?: boolean }) {
  return (
    <Link href={href} className={`flex h-11 items-center justify-center border-b-2 text-xs font-semibold ${active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}>
      {label}
    </Link>
  );
}

function Metric({ label, value, valueClassName = "text-slate-700", alignRight = false }: { label: string; value: string; valueClassName?: string; alignRight?: boolean }) {
  return (
    <div className={alignRight ? "text-right" : ""}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-0.5 truncate font-semibold tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}

function FundList({
  title,
  funds,
  activeKey,
  prefix,
  valueClass,
  onSelect,
  cleared = false,
}: {
  title: string;
  funds: Array<MobileInvestmentFundPosition | MobileInvestmentClearedPosition>;
  activeKey: string;
  prefix: "holding" | "cleared";
  valueClass: (value: number) => string;
  onSelect: (key: string) => void;
  cleared?: boolean;
}) {
  const { t } = useI18n();
  if (funds.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-slate-500">{title}</div>
      <div className="space-y-1.5">
        {funds.map((fund) => {
          const key = `${prefix}:${fund.fundCode}`;
          const active = key === activeKey;
          const profit = cleared ? (fund as MobileInvestmentClearedPosition).historicalProfit : (fund as MobileInvestmentFundPosition).floatingPnL;
          const value = cleared ? (fund as MobileInvestmentClearedPosition).redeemAmount : (fund as MobileInvestmentFundPosition).marketValue;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition ${active ? "border-indigo-300 bg-indigo-50/50" : "border-slate-100 bg-slate-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-700">{fund.fundName || fund.fundCode}</div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-slate-400">{fund.fundCode}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs font-semibold tabular-nums text-slate-700">{formatMoneyYuan(value)}</div>
                  <div className={`mt-0.5 text-[11px] font-semibold tabular-nums ${valueClass(profit)}`}>
                    {cleared ? t("mobileInvestments.historicalProfitShort") : t("overview.floatingPnL")} {formatMoneyYuan(profit)}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FundDetailPanel({
  item,
  showTransactions,
  valueClass,
  onToggleTransactions,
}: {
  item: { key: string; kind: "holding" | "cleared"; fund: MobileInvestmentFundPosition | MobileInvestmentClearedPosition };
  showTransactions: boolean;
  valueClass: (value: number) => string;
  onToggleTransactions: () => void;
}) {
  const { t } = useI18n();
  const fund = item.fund;
  const isCleared = item.kind === "cleared";
  const entries = fund.entries;
  const chart = fund.chart;
  const profit = isCleared ? (fund as MobileInvestmentClearedPosition).historicalProfit : (fund as MobileInvestmentFundPosition).floatingPnL;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-2">
        <div className="truncate text-sm font-semibold text-slate-800">{fund.fundName || fund.fundCode}</div>
        <div className="mt-0.5 text-[11px] tabular-nums text-slate-400">{fund.fundCode}</div>
      </div>
      <div className="p-3">
        <SimpleLineChart points={chart} />
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          {isCleared ? (
            <>
              <Metric label={t("mobileInvestments.buyAmount")} value={formatMoneyYuan((fund as MobileInvestmentClearedPosition).buyAmount)} />
              <Metric label={t("mobileInvestments.redeemAmount")} value={formatMoneyYuan((fund as MobileInvestmentClearedPosition).redeemAmount)} alignRight />
              <Metric label={t("mobileInvestments.historicalProfit")} value={formatMoneyYuan(profit)} valueClassName={valueClass(profit)} />
              <Metric label={t("invest.floatingRate")} value={formatPercent((fund as MobileInvestmentClearedPosition).returnRate)} valueClassName={valueClass((fund as MobileInvestmentClearedPosition).returnRate)} alignRight />
            </>
          ) : (
            <>
              <Metric label={t("investments.marketValue")} value={formatMoneyYuan((fund as MobileInvestmentFundPosition).marketValue)} />
              <Metric label={t("mobileInvestments.cost")} value={formatMoneyYuan((fund as MobileInvestmentFundPosition).cost)} alignRight />
              <Metric label={t("overview.floatingPnL")} value={formatMoneyYuan(profit)} valueClassName={valueClass(profit)} />
              <Metric label={t("invest.floatingRate")} value={formatPercent((fund as MobileInvestmentFundPosition).floatingRate)} valueClassName={valueClass((fund as MobileInvestmentFundPosition).floatingRate)} alignRight />
            </>
          )}
        </div>
        <button type="button" onClick={onToggleTransactions} className="mt-3 flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
          <span>{t("mobileInvestments.transactions")}</span>
          <span>{showTransactions ? t("mobileInvestments.collapse") : t("mobileInvestments.expand")}</span>
        </button>
        {showTransactions ? (
          <div className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100">
            {entries.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">{t("mobileInvestments.noTransactions")}</div>
            ) : entries.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[72px_minmax(0,1fr)_88px] gap-2 px-3 py-2 text-xs">
                <div className="tabular-nums text-slate-400">{entry.date}</div>
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-600">{subtypeText(t, entry.subtype, entry.source)}</div>
                  <div className="mt-0.5 truncate tabular-nums text-[11px] text-slate-400">
                    {entry.nav != null ? t("mobileInvestments.navWithValue", { value: entry.nav.toFixed(4) }) : ""}
                    {entry.units != null ? ` · ${t("mobileInvestments.unitsWithValue", { value: entry.units.toFixed(2) })}` : ""}
                  </div>
                </div>
                <div className={`text-right font-semibold tabular-nums ${valueClass(entry.amount)}`}>{formatMoneyYuan(entry.amount)}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SimpleLineChart({ points }: { points: MobileInvestmentFundChartPoint[] }) {
  const { t } = useI18n();
  const data = points.filter((point) => Number.isFinite(point.nav));
  if (data.length < 2) {
    return <div className="flex h-36 items-center justify-center rounded-lg bg-slate-50 text-xs text-slate-400">{t("mobileInvestments.noChartData")}</div>;
  }
  const width = 320;
  const height = 140;
  const padding = 12;
  const values = data.map((point) => point.nav);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = data.map((point, index) => {
    const x = padding + (index / Math.max(1, data.length - 1)) * (width - padding * 2);
    const y = padding + ((max - point.nav) / span) * (height - padding * 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = data[0]!;
  const latest = data[data.length - 1]!;
  return (
    <div className="rounded-lg bg-slate-50 p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" role="img" aria-label={t("mobileInvestments.chart")}> 
        <path d={`M${padding},${height - padding}H${width - padding}`} stroke="#e2e8f0" strokeWidth="1" />
        <path d={path} fill="none" stroke="#4f46e5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      </svg>
      <div className="flex justify-between text-[11px] tabular-nums text-slate-400">
        <span>{first.date} · {first.nav.toFixed(4)}</span>
        <span>{latest.date} · {latest.nav.toFixed(4)}</span>
      </div>
    </div>
  );
}

function subtypeText(t: (key: string) => string, subtype: string, source: string) {
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("fundShell.subtype.buyRefund");
  if (subtype === "buy_failed") return t("fundShell.subtype.buyFailed");
  if (subtype === "buy" && source === "regular_invest") return t("fund.subtype.regular_invest");
  if (subtype === "buy" && source === "dividend") return t("fund.subtype.dividend_reinvest");
  if (subtype === "buy") return t("fund.subtype.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_cash") return t("fundShell.subtype.dividendCash");
  if (subtype === "dividend_reinvest") return t("fundShell.subtype.dividendReinvest");
  if (subtype === "switch_in") return t("fund.subtype.switch");
  if (subtype === "switch_out") return t("fund.subtype.switch_out");
  return t("fundShell.subtype.unknown");
}
