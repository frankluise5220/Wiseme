"use client";

import {
  Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  Line,
  PieChart, Pie, Cell,
  ComposedChart,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

const COLORS = {
  investPnL: "#8b5cf6",
  net: "#3b82f6",
};
const PIE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#f43f5e", "#84cc16"];

type MonthData = {
  month: string;
  income: number;
  expense: number;
  investPnL: number;
  netTotal: number;
};

type CategoryData = {
  id?: string | null;
  name: string;
  value: number;
  pct: number;
};

type TagGroupData = {
  id: string;
  name: string;
  color: string;
  value: number;
  pct: number;
};

type PnLItem = {
  id: string;
  date: string;
  fundCode: string;
  fundName: string;
  subtype: string;
  amount: number;
  profit: number;
  profitRate: number;
};

type Props = {
  monthData: MonthData[];
  incomeCats: CategoryData[];
  expenseCats: CategoryData[];
  incomeTagGroups: TagGroupData[];
  expenseTagGroups: TagGroupData[];
  pnlList: PnLItem[];
  isRedUp: boolean;
};

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <div className="font-medium text-slate-700 mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="tabular-nums font-medium">{formatMoney(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function renderPieLabel({ name, percent }: { name?: string; percent?: number }) {
  if (!name || !percent || percent < 0.05) return "";
  return `${name} ${(percent * 100).toFixed(1)}%`;
}

export default function StatisticsCharts({ monthData, incomeCats, expenseCats, incomeTagGroups, expenseTagGroups, pnlList, isRedUp }: Props) {
  const { t } = useI18n();
  const compactTick = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}${t("common.compactUnit")}` : String(v));
  const pnlCls = (n: number) => pnlClassFromRedUp(n, isRedUp);
  const pnlClsText = pnlCls(1);
  const lossClsText = pnlCls(-1);
  const incomeChartColor = isRedUp ? "#dc2626" : "#10b981";
  const expenseChartColor = isRedUp ? "#10b981" : "#dc2626";
  const pnlTypeBadge = (item: PnLItem) => {
    if (item.subtype.includes("分红")) return "bg-emerald-50 text-emerald-600";
    return item.profit >= 0 ? "bg-orange-50 text-orange-600" : "bg-rose-50 text-rose-600";
  };

  const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
  const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);
  const totalInvestPnL = monthData.reduce((s, m) => s + m.investPnL, 0);
  const totalNet = totalIncome - totalExpense + totalInvestPnL;

  return (
    <div className="space-y-6">
      {/* ===== Summary cards ===== */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { kind: "income", label: t("stats.totalIncome"), value: totalIncome, cls: pnlClsText },
          { kind: "expense", label: t("stats.totalExpense"), value: -totalExpense, cls: lossClsText },
          { kind: "net", label: t("stats.netIncome"), value: totalIncome - totalExpense, cls: pnlCls(totalIncome - totalExpense) },
          { kind: "invest", label: t("stats.investPnL"), value: totalInvestPnL, cls: pnlCls(totalInvestPnL) },
          { kind: "total", label: t("stats.totalPnL"), value: totalNet, cls: pnlCls(totalNet) },
        ].map((c) => (
          <div key={c.kind} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-[11px] text-slate-500 mb-1">{c.label}</div>
            <div className={`text-lg font-bold tabular-nums ${c.cls}`}>
              {c.value >= 0 && c.kind !== "expense" ? "+" : ""}{formatMoney(c.value)}
            </div>
          </div>
        ))}
      </div>

      {/* ===== Monthly income/expense bar chart ===== */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">{t("stats.monthlyIncomeExpense")}</div>
        </div>
        <div className="p-3">
          {monthData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs text-slate-400">{t("table.empty")}</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={monthData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} tickFormatter={compactTick} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="income" name={t("stats.income")} fill={incomeChartColor} radius={[3, 3, 0, 0]} barSize={16} />
                <Bar dataKey="expense" name={t("stats.expense")} fill={expenseChartColor} radius={[3, 3, 0, 0]} barSize={16} />
                <Line type="monotone" dataKey="netTotal" name={t("stats.totalPnL")} stroke={COLORS.net} strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ===== Pie chart row: income sources + expense categories ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Income pie chart */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">{t("stats.incomeSources")}</div>
          </div>
          <div className="p-3">
            {incomeCats.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">{t("stats.noIncomeData")}</div>
            ) : (
              <div className="flex items-center">
                <ResponsiveContainer width="55%" height={240}>
                  <PieChart>
                    <Pie data={incomeCats} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                      {incomeCats.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {incomeCats.map((c, i) => (
                    <div key={c.name} className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.name}</span>
                      <span className="tabular-nums text-slate-400">{c.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Expense pie chart */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-semibold text-slate-800">{t("stats.expenseCategories")}</div>
          </div>
          <div className="p-3">
            {expenseCats.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-400">{t("stats.noExpenseData")}</div>
            ) : (
              <div className="flex items-center">
                <ResponsiveContainer width="55%" height={240}>
                  <PieChart>
                    <Pie data={expenseCats} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                      {expenseCats.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5">
                  {expenseCats.map((c, i) => (
                    <div key={c.name} className="flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.name}</span>
                      <span className="tabular-nums text-slate-400">{c.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== Tag-grouped pie charts (shown only when tag data exists) ===== */}
      {(incomeTagGroups.length > 0 || expenseTagGroups.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Income tag pie chart */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">{t("stats.incomeTagDistribution")}</div>
            </div>
            <div className="p-3">
              {incomeTagGroups.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-400">{t("stats.noIncomeTagData")}</div>
              ) : (
                <div className="flex items-center">
                  <ResponsiveContainer width="55%" height={240}>
                    <PieChart>
                      <Pie data={incomeTagGroups} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                        {incomeTagGroups.map((t) => <Cell key={t.id} fill={t.color} />)}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {incomeTagGroups.slice(0, 6).map((t) => (
                      <div key={t.id} className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                        <span className="text-slate-600 truncate flex-1">{t.name}</span>
                        <span className="tabular-nums text-slate-400">{t.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Expense tag pie chart */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">{t("stats.expenseTagDistribution")}</div>
            </div>
            <div className="p-3">
              {expenseTagGroups.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-xs text-slate-400">{t("stats.noExpenseTagData")}</div>
              ) : (
                <div className="flex items-center">
                  <ResponsiveContainer width="55%" height={240}>
                    <PieChart>
                      <Pie data={expenseTagGroups} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={2} label={renderPieLabel} labelLine={false}>
                        {expenseTagGroups.map((t) => <Cell key={t.id} fill={t.color} />)}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {expenseTagGroups.slice(0, 6).map((t) => (
                      <div key={t.id} className="flex items-center gap-1.5 text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                        <span className="text-slate-600 truncate flex-1">{t.name}</span>
                        <span className="tabular-nums text-slate-400">{t.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== P/L detail list ===== */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">{t("stats.investPnLDetail")}</div>
          <div className="text-xs text-slate-500">{t("stats.recordCount", { count: pnlList.length })}</div>
        </div>
        {pnlList.length === 0 ? (
          <div className="px-4 py-8 text-xs text-slate-400 text-center">{t("stats.noRealizedRecords")}</div>
        ) : (
          <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
            <table className="w-full table-fixed border-separate border-spacing-0">
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">{t("detail.column.date")}</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{t("stats.fund")}</th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{t("stats.type")}</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{t("stats.amount")}</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{t("stats.pnl")}</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{t("stats.rate")}</th>
                </tr>
              </thead>
              <tbody>
                {pnlList.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{e.date}</td>
                    <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">
                      {e.fundName || e.fundCode}{e.fundName && e.fundCode && e.fundName !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-xs">
                      <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${pnlTypeBadge(e)}`}>
                        {e.subtype || (e.profit >= 0 ? t("stats.investProfit") : t("stats.investLoss"))}
                      </span>
                    </td>
                    <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">{formatMoney(Math.abs(e.amount))}</td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums font-medium ${e.profit >= 0 ? pnlClsText : lossClsText}`}>
                      {e.profit >= 0 ? "+" : ""}{formatMoney(e.profit)}
                    </td>
                    <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${e.profit >= 0 ? pnlClsText : lossClsText}`}>
                      {e.profitRate !== 0 ? `${(e.profitRate * 100).toFixed(2)}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-50">
                <tr>
                  <td className="px-4 py-2 border-t border-slate-200 text-xs font-semibold text-slate-700" colSpan={4}>{t("common.total")}</td>
                  <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums font-semibold ${pnlCls(pnlList.reduce((s, e) => s + e.profit, 0))}`}>
                    {(() => { const t = pnlList.reduce((s, e) => s + e.profit, 0); return (t >= 0 ? "+" : "") + formatMoney(t); })()}
                  </td>
                  <td className="px-3 py-2 border-t border-slate-200"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
