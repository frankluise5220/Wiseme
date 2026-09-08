package com.mmh.app.ui.statistics

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.StatisticsCategoryDto
import com.mmh.app.data.remote.dto.StatisticsMonthDto
import com.mmh.app.data.remote.dto.StatisticsPnLItemDto
import com.mmh.app.data.remote.dto.StatisticsTagGroupDto
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatDate
import com.mmh.app.ui.util.formatPnl
import com.mmh.app.ui.util.formatRate

/**
 * 资金统计页面。
 *
 * 对标网页端 /statistics 页面，展示：
 * - 年度汇总（收入、支出、投资盈亏、净结余）
 * - 月度趋势柱状图
 * - 收入/支出分类饼图
 * - 标签分组饼图
 * - 投资盈亏列表
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatisticsScreen(
    viewModel: StatisticsViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    if (uiState.isLoading && uiState.monthData.isEmpty()) {
        SkeletonLoading()
    } else {
        PullToRefreshBox(
            isRefreshing = uiState.isLoading,
            onRefresh = { viewModel.retry() },
            modifier = Modifier.fillMaxSize()
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                // ═══ 年度选择器 + 汇总 ═══
                item {
                    YearSummaryCard(
                        year = uiState.year,
                        totalIncome = uiState.totalIncome,
                        totalExpense = uiState.totalExpense,
                        totalInvestPnL = uiState.totalInvestPnL,
                        totalNet = uiState.totalNet,
                        onPrevYear = { viewModel.changeYear(-1) },
                        onNextYear = { viewModel.changeYear(1) }
                    )
                }

                // ═══ 月度趋势 ═══
                if (uiState.monthData.isNotEmpty()) {
                    item { SectionHeader("月度趋势") }
                    item {
                        MonthlyBarChart(
                            monthData = uiState.monthData
                        )
                    }
                }

                // ═══ 收入分类饼图 ═══
                if (uiState.incomeCategories.isNotEmpty()) {
                    item { SectionHeader("收入分类") }
                    item {
                        PieChartCard(
                            items = uiState.incomeCategories.map { Triple(it.name, it.value, it.pct) },
                            totalLabel = "总收入",
                            totalValue = uiState.totalIncome
                        )
                    }
                }

                // ═══ 支出分类饼图 ═══
                if (uiState.expenseCategories.isNotEmpty()) {
                    item { SectionHeader("支出分类") }
                    item {
                        PieChartCard(
                            items = uiState.expenseCategories.map { Triple(it.name, it.value, it.pct) },
                            totalLabel = "总支出",
                            totalValue = uiState.totalExpense
                        )
                    }
                }

                // ═══ 收入标签分组 ═══
                if (uiState.incomeTagGroups.isNotEmpty()) {
                    item { SectionHeader("收入标签") }
                    item {
                        TagGroupCard(uiState.incomeTagGroups)
                    }
                }

                // ═══ 支出标签分组 ═══
                if (uiState.expenseTagGroups.isNotEmpty()) {
                    item { SectionHeader("支出标签") }
                    item {
                        TagGroupCard(uiState.expenseTagGroups)
                    }
                }

                // ═══ 投资盈亏列表 ═══
                if (uiState.pnlList.isNotEmpty()) {
                    item { SectionHeader("投资盈亏") }
                    items(uiState.pnlList, key = { it.id }) { pnl ->
                        PnLItemCard(pnl)
                    }
                }

                // ═══ 错误提示 ═══
                uiState.error?.let { msg ->
                    item { ErrorBanner(msg) { viewModel.retry() } }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 年度汇总卡
// ─────────────────────────────────────────────────────────────────

@Composable
private fun YearSummaryCard(
    year: Int,
    totalIncome: Double,
    totalExpense: Double,
    totalInvestPnL: Double,
    totalNet: Double,
    onPrevYear: () -> Unit,
    onNextYear: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // 年份选择器
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevYear, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Default.KeyboardArrowLeft,
                        contentDescription = "上一年",
                        tint = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f),
                        modifier = Modifier.size(24.dp)
                    )
                }
                Text(
                    text = "${year}年",
                    style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp),
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onPrimary
                )
                IconButton(onClick = onNextYear, modifier = Modifier.size(32.dp)) {
                    Icon(
                        Icons.Default.KeyboardArrowRight,
                        contentDescription = "下一年",
                        tint = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f),
                        modifier = Modifier.size(24.dp)
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // 净结余
            Text(
                text = formatPnl(totalNet),
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 28.sp),
                fontWeight = FontWeight.Bold,
                color = if (totalNet >= 0) MaterialTheme.colorScheme.onPrimary else Color(0xFFFF8A80)
            )

            Spacer(modifier = Modifier.height(20.dp))

            // 三列数据
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                StatItem("收入", formatAmount(totalIncome), Color(0xFF4CAF50))
                StatItem("支出", formatAmount(totalExpense), Color(0xFFEF5350))
                StatItem("投资盈亏", formatPnl(totalInvestPnL), if (totalInvestPnL >= 0) Color(0xFF4CAF50) else Color(0xFFEF5350))
            }
        }
    }
}

@Composable
private fun StatItem(label: String, value: String, valueColor: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f)
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp),
            fontWeight = FontWeight.SemiBold,
            color = valueColor
        )
    }
}

// ─────────────────────────────────────────────────────────────────
// 月度趋势柱状图
// ─────────────────────────────────────────────────────────────────

@Composable
private fun MonthlyBarChart(monthData: List<StatisticsMonthDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            val maxVal = (monthData.maxOfOrNull { maxOf(it.income, it.expense, it.investPnL) } ?: 1.0).coerceAtLeast(1.0)

            monthData.forEach { m ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Month label
                    Text(
                        text = "${m.month}月",
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.width(36.dp),
                        textAlign = TextAlign.End
                    )

                    Spacer(modifier = Modifier.width(8.dp))

                    // Income bar (green)
                    if (m.income > 0) {
                        Box(
                            modifier = Modifier
                                .height(14.dp)
                                .weight((m.income / maxVal).toFloat())
                                .clip(RoundedCornerShape(4.dp))
                                .background(Color(0xFF4CAF50))
                        )
                    } else {
                        Spacer(modifier = Modifier.weight(1f))
                    }

                    Spacer(modifier = Modifier.width(4.dp))

                    // Expense bar (red)
                    if (m.expense > 0) {
                        Box(
                            modifier = Modifier
                                .height(14.dp)
                                .weight((m.expense / maxVal).toFloat())
                                .clip(RoundedCornerShape(4.dp))
                                .background(Color(0xFFEF5350))
                        )
                    } else {
                        Spacer(modifier = Modifier.weight(1f))
                    }

                    Spacer(modifier = Modifier.width(8.dp))

                    // Net value
                    Text(
                        text = formatPnl(m.netTotal),
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp),
                        fontWeight = FontWeight.Medium,
                        color = if (m.netTotal >= 0) Color(0xFF4CAF50) else Color(0xFFEF5350),
                        modifier = Modifier.width(100.dp),
                        textAlign = TextAlign.End
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))
            }

            // Legend
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center
            ) {
                LegendDot(Color(0xFF4CAF50), "收入")
                Spacer(modifier = Modifier.width(16.dp))
                LegendDot(Color(0xFFEF5350), "支出")
                Spacer(modifier = Modifier.width(16.dp))
                Text("数值=净结余", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(color)
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// ─────────────────────────────────────────────────────────────────
// 分类饼图
// ─────────────────────────────────────────────────────────────────

@Composable
private fun PieChartCard(
    items: List<Triple<String, Double, Double>>,
    totalLabel: String,
    totalValue: Double
) {
    val palette = listOf(
        Color(0xFF1976D2), Color(0xFF388E3C), Color(0xFFFB8C00),
        Color(0xFF8E24AA), Color(0xFF00ACC1), Color(0xFFE53935),
        Color(0xFF6D4C41), Color(0xFF5C6BC0)
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left: Pie donut
            Box(
                modifier = Modifier.size(120.dp),
                contentAlignment = Alignment.Center
            ) {
                val total = items.sumOf { it.second }.coerceAtLeast(1.0)
                val strokeWidth = 18f
                Canvas(modifier = Modifier.fillMaxSize()) {
                    var startAngle = -90f
                    items.forEachIndexed { i, (_, value, _) ->
                        val sweep = (value / total * 360f).toFloat()
                        if (sweep > 0f) {
                            drawArc(
                                color = palette[i % palette.size],
                                startAngle = startAngle,
                                sweepAngle = sweep,
                                useCenter = false,
                                topLeft = Offset(strokeWidth / 2, strokeWidth / 2),
                                size = Size(size.width - strokeWidth, size.height - strokeWidth),
                                style = Stroke(width = strokeWidth, cap = StrokeCap.Butt)
                            )
                            startAngle += sweep
                        }
                    }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(totalLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        formatAmount(totalValue),
                        style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            Spacer(modifier = Modifier.width(16.dp))

            // Right: legend list
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items.forEachIndexed { i, (name, value, pct) ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(palette[i % palette.size])
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = name,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                            maxLines = 1
                        )
                        Text(
                            text = "${String.format("%.1f", pct)}%",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(
                            text = formatAmount(value),
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 标签分组
// ─────────────────────────────────────────────────────────────────

@Composable
private fun TagGroupCard(tags: List<StatisticsTagGroupDto>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            tags.forEach { tag ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Color dot
                    val tagColor = try {
                        Color(android.graphics.Color.parseColor(tag.color))
                    } catch (_: Exception) {
                        Color(0xFF3B82F6)
                    }
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(tagColor)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = tag.name,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                        maxLines = 1
                    )
                    Text(
                        text = "${String.format("%.1f", tag.pct)}%",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = formatAmount(tag.value),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 投资盈亏列表
// ─────────────────────────────────────────────────────────────────

@Composable
private fun PnLItemCard(pnl: StatisticsPnLItemDto) {
    val profitColor = if (pnl.profit >= 0) Color(0xFF4CAF50) else Color(0xFFEF5350)

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left: fund icon
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Default.ShowChart, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            // Fund name + date
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = pnl.fundName.ifEmpty { pnl.fundCode },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1
                )
                Text(
                    text = "${formatDate(pnl.date)} · ${subtypeLabel(pnl.subtype)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Profit
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = formatPnl(pnl.profit),
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                    fontWeight = FontWeight.Bold,
                    color = profitColor
                )
                Text(
                    text = formatRate(pnl.profitRate),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

private fun subtypeLabel(subtype: String): String = when (subtype) {
    "dividend_cash" -> "现金分红"
    "redeem" -> "赎回"
    "buy" -> "买入"
    else -> subtype
}

// ─────────────────────────────────────────────────────────────────
// 骨架加载态
// ─────────────────────────────────────────────────────────────────

@Composable
private fun SkeletonLoading() {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        repeat(5) {
            Card(
                modifier = Modifier.fillMaxWidth().height(if (it == 0) 180.dp else 120.dp),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {}
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 辅助组件
// ─────────────────────────────────────────────────────────────────

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(top = 2.dp)
    )
}

@Composable
private fun ErrorBanner(message: String, onRetry: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onRetry) { Text("重试") }
        }
    }
}
