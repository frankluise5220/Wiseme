"use client";

import { useEffect, useRef, useState } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  Area, Cell,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type FundTrendPoint = {
  month: string;
  cost: number;
  marketValue: number;
  floatingPnL: number;
  cumNetInvested: number;
  netFlow: number;
  /** 当月现金分红（¥）；不冲减成本，计入已实现收益 */
  dividendCash?: number;
  flowKind: "buy" | "redeem" | "dividend" | "none";
};

type BenchmarkPoint = {
  month: string;
  normNav: number;
  rawNav: number;
};

type ApiResponse = {
  /** API 响应带 ok；RSC 预取（loadFundPortfolioTrendData 直接传值）没有，故可选 */
  ok?: boolean;
  points: FundTrendPoint[];
  emptyMonths: string[];
  benchmark: BenchmarkPoint[];
  rangeStart: string;
  rangeEnd: string;
  error?: string;
};

type ChartRow = FundTrendPoint & {
  /** 1 + 组合累计收益率；与基准归一化净值同轴（值 = 1 即 0%） */
  portfolioPct: number | null;
  /** 基准归一化净值（首月 = 1） */
  benchmarkPct: number | null;
  /** 当月无任何交易（后端 emptyMonths） */
  isEmpty: boolean;
};

const COLORS = {
  cost: "#94a3b8",         // slate-400
  marketValue: "#3b82f6",  // blue-500
  cumInvested: "#f59e0b",  // amber-500
  benchmark: "#ef4444",    // red-500
  portfolioReturn: "#0d9488", // teal-600
  netFlowBuy: "#10b981",
  netFlowRedeem: "#f43f5e",
  netFlowDividend: "#a855f7",
};

type Props = {
  /** Optional pre-fetched data (from RSC). When provided, skips the API call. */
  initialData?: ApiResponse | null;
  /** Force the API to be called on mount even if initialData is present */
  refreshKey?: number;
};

function compactTick(v: number) {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatPct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function flowColor(kind: FundTrendPoint["flowKind"]): string {
  if (kind === "redeem") return COLORS.netFlowRedeem;
  if (kind === "dividend") return COLORS.netFlowDividend;
  return COLORS.netFlowBuy;
}

function buildChartData(
  points: FundTrendPoint[],
  benchmark: BenchmarkPoint[],
  emptyMonths: string[],
): ChartRow[] {
  const benchMap = new Map(benchmark.map((b) => [b.month, b.normNav]));
  const emptySet = new Set(emptyMonths);
  return points.map((p) => ({
    ...p,
    portfolioPct: p.cumNetInvested > 0 ? 1 + p.floatingPnL / p.cumNetInvested : null,
    benchmarkPct: benchMap.get(p.month) ?? null,
    isEmpty: emptySet.has(p.month),
  }));
}

function buildQuery(startMonth: string, endMonth: string, withBenchmark: boolean) {
  const params = new URLSearchParams();
  if (startMonth) params.set("start", startMonth);
  if (endMonth) params.set("end", endMonth);
  if (withBenchmark) params.set("benchmark", "1");
  return params.toString();
}

export default function FundPortfolioTrendChart({ initialData, refreshKey }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<ApiResponse | null>(initialData ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 每条数据线独立开关（基准默认显示：RSC 预取时已带 benchmark 数据）
  const [showBenchmark, setShowBenchmark] = useState(true);
  const [showPortfolioReturn, setShowPortfolioReturn] = useState(true);
  const [showFlow, setShowFlow] = useState(true);
  const [showMarketValue, setShowMarketValue] = useState(true);
  const [showCost, setShowCost] = useState(true);
  const [showCumInvested, setShowCumInvested] = useState(false);
  const autoFetchedRef = useRef(false);

  // Sync to initialData when prop changes (RSC re-render)
  useEffect(() => {
    if (initialData) {
      setData(initialData);
    }
  }, [initialData, refreshKey]);

  useEffect(() => {
    if (initialData && !refreshKey) return; // rely on prop unless explicitly refreshing
    if (!data) {
      setLoading(true);
    }
  }, [initialData, refreshKey, data]);

  const fetchData = async (withBench: boolean) => {
    setLoading(true);
    setError("");
    try {
      const startMonth = data?.rangeStart || "";
      const endMonth = data?.rangeEnd || "";
      const url = `/api/v1/statistics/fund-trend?${buildQuery(startMonth, endMonth, withBench)}`;
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || "加载失败");
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  // RSC 预取的 initialData 可能没有基准（BenchmarkCache 为空，页面 SSR 不拉外部 API）；
  // 有持仓数据而基准为空时，mount 后自动补拉一次（API 路由会顺带刷新基准缓存）。
  useEffect(() => {
    if (autoFetchedRef.current) return;
    if (!data || data.points.length === 0) return;
    if (data.benchmark && data.benchmark.length > 0) return;
    autoFetchedRef.current = true;
    fetchData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const toggleBenchmark = () => {
    const next = !showBenchmark;
    setShowBenchmark(next);
    // Fetch fresh data with benchmark flag when enabling and no benchmark yet
    if (next && (!data?.benchmark || data.benchmark.length === 0)) {
      fetchData(true);
    }
  };

  const SERIES_CHIPS: { key: string; label: string; color: string; active: boolean; onToggle: () => void }[] = [
    { key: "marketValue", label: t("stats.totalMarketValue"), color: COLORS.marketValue, active: showMarketValue, onToggle: () => setShowMarketValue(v => !v) },
    { key: "cost", label: t("stats.totalCost"), color: COLORS.cost, active: showCost, onToggle: () => setShowCost(v => !v) },
    { key: "cumInvested", label: t("stats.cumNetInvested"), color: COLORS.cumInvested, active: showCumInvested, onToggle: () => setShowCumInvested(v => !v) },
    { key: "portfolioReturn", label: t("stats.portfolioReturn"), color: COLORS.portfolioReturn, active: showPortfolioReturn, onToggle: () => setShowPortfolioReturn(v => !v) },
    { key: "benchmark", label: t("stats.csi300Benchmark"), color: COLORS.benchmark, active: showBenchmark, onToggle: toggleBenchmark },
    { key: "flow", label: t("stats.monthlyNetFlow"), color: COLORS.netFlowBuy, active: showFlow, onToggle: () => setShowFlow(v => !v) },
  ];

  if (error) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {t("stats.fundPortfolioTrend")}
          </div>
        </div>
        <div className="p-6 text-xs text-rose-500 text-center">{error}</div>
      </div>
    );
  }

  const points = data?.points ?? [];
  const benchmark = data?.benchmark ?? [];
  const hasData = points.length > 0 && points.some((p) => p.marketValue > 0 || p.cost > 0);
  const chartData = hasData ? buildChartData(points, benchmark, data?.emptyMonths ?? []) : [];
  // Right pct axis is needed when either pct line is visible.
  const showPctAxis = (showBenchmark && benchmark.length > 0) || showPortfolioReturn;

  // Summary metrics
  const lastPoint = points[points.length - 1];
  const totalCost = lastPoint?.cost ?? 0;
  const totalValue = lastPoint?.marketValue ?? 0;
  const totalPnL = lastPoint?.floatingPnL ?? 0;
  const totalCumInvested = lastPoint?.cumNetInvested ?? 0;
  const totalRate = totalCumInvested > 0 ? totalPnL / totalCumInvested : 0;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div className="text-sm font-semibold text-slate-800">
          {t("stats.fundPortfolioTrend")}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {SERIES_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onToggle}
              className={`h-6 px-2 rounded text-[11px] border flex items-center gap-1.5 ${
                chip.active
                  ? "bg-white border-slate-300 text-slate-700"
                  : "bg-slate-100 border-slate-200 text-slate-400"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: chip.active ? chip.color : "#cbd5e1" }}
              />
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        {!hasData ? (
          <div className="h-72 flex items-center justify-center text-xs text-slate-400">
            {loading ? "加载中..." : t("stats.noFundTrendData")}
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
              <SummaryCard
                label={t("stats.totalCost")}
                value={formatMoney(totalCost)}
                hint=""
              />
              <SummaryCard
                label={t("stats.totalMarketValue")}
                value={formatMoney(totalValue)}
                hint=""
              />
              <SummaryCard
                label={t("stats.floatingPnL")}
                value={`${totalPnL >= 0 ? "+" : ""}${formatMoney(totalPnL)}`}
                hint={totalCumInvested > 0 ? `${(totalRate * 100).toFixed(2)}%` : ""}
                positive={totalPnL >= 0}
              />
              <SummaryCard
                label={t("stats.cumNetInvested")}
                value={formatMoney(totalCumInvested)}
                hint=""
              />
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="marketValueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.marketValue} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={COLORS.marketValue} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="cumInvestedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS.cumInvested} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={COLORS.cumInvested} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={16}
                />
                <YAxis
                  yAxisId="value"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={compactTick}
                />
                {showPctAxis && (
                  <YAxis
                    yAxisId="pct"
                    orientation="right"
                    tick={{ fontSize: 11, fill: "#64748b" }}
                    axisLine={false}
                    tickLine={false}
                    domain={["auto", "auto"]}
                    tickFormatter={(v) => `${((v - 1) * 100).toFixed(0)}%`}
                  />
                )}
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const point = chartData.find((p) => p.month === label);
                    const isPctKey = (key: unknown) =>
                      key === "benchmarkPct" || key === "portfolioPct";
                    return (
                      <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs min-w-[180px]">
                        <div className="font-medium text-slate-700 mb-1">{label}</div>
                        {payload.map((p: any, i: number) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                            <span className="text-slate-500">{p.name}:</span>
                            <span className="tabular-nums font-medium ml-auto">
                              {isPctKey(p.dataKey)
                                ? formatPct(p.value - 1)
                                : formatMoney(p.value)}
                            </span>
                          </div>
                        ))}
                        {point && point.netFlow !== 0 && (
                          <div className="mt-1.5 pt-1.5 border-t border-slate-100 text-slate-500">
                            净流入：
                            <span className="tabular-nums font-medium ml-1">
                              {point.netFlow >= 0 ? "+" : ""}{formatMoney(point.netFlow)}
                            </span>
                          </div>
                        )}
                        {point && (point.dividendCash ?? 0) !== 0 && (
                          <div className="text-slate-500">
                            现金分红：
                            <span className="tabular-nums font-medium ml-1">
                              +{formatMoney(point.dividendCash ?? 0)}
                            </span>
                          </div>
                        )}
                        {point?.isEmpty && (
                          <div className="mt-1 text-slate-400">{t("stats.noTradeMonth")}</div>
                        )}
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />

                {showCumInvested && (
                  <Area
                    yAxisId="value"
                    type="monotone"
                    dataKey="cumNetInvested"
                    name={t("stats.cumNetInvested")}
                    stroke={COLORS.cumInvested}
                    strokeWidth={1.5}
                    fill="url(#cumInvestedGrad)"
                    dot={false}
                  />
                )}
                {showMarketValue && (
                  <Area
                    yAxisId="value"
                    type="monotone"
                    dataKey="marketValue"
                    name={t("stats.totalMarketValue")}
                    stroke={COLORS.marketValue}
                    strokeWidth={2.5}
                    fill="url(#marketValueGrad)"
                    dot={{ r: 2, fill: COLORS.marketValue }}
                  />
                )}
                {showCost && (
                  <Line
                    yAxisId="value"
                    type="monotone"
                    dataKey="cost"
                    name={t("stats.totalCost")}
                    stroke={COLORS.cost}
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                )}

                {showFlow && (
                  <Bar
                    yAxisId="value"
                    dataKey="netFlow"
                    name={t("stats.monthlyNetFlow")}
                    fill={COLORS.netFlowBuy}
                    radius={[2, 2, 0, 0]}
                    barSize={10}
                  >
                    {chartData.map((p) => (
                      <Cell key={p.month} fill={flowColor(p.flowKind)} />
                    ))}
                  </Bar>
                )}

                {showPortfolioReturn && (
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="portfolioPct"
                    name={t("stats.portfolioReturn")}
                    stroke={COLORS.portfolioReturn}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                )}
                {showBenchmark && benchmark.length > 0 && (
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey="benchmarkPct"
                    name={t("stats.csi300Benchmark")}
                    stroke={COLORS.benchmark}
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>

            <div className="text-[10px] text-slate-400 mt-1.5 px-1 space-y-0.5">
              {showFlow && <div>{t("stats.flowLegendNote")}</div>}
              <div>{t("stats.fundTrendNote")}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  positive,
}: {
  label: string;
  value: string;
  hint: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div
        className={`text-sm font-semibold tabular-nums ${
          positive === undefined
            ? "text-slate-700"
            : positive
              ? "text-rose-600"
              : "text-emerald-600"
        }`}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}
