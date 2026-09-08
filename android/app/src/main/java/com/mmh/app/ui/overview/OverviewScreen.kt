package com.mmh.app.ui.overview

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.AccountTypeTotalsDto
import com.mmh.app.ui.theme.pnlColor
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatPnl
import kotlin.math.abs

/**
 * 金额隐藏时的占位符。用足够长的星号串，使隐藏/显示切换时宽度接近、不突兀。
 * 星号字形比数字窄，因此数量多于数字位数才能达到相近视觉宽度。
 */
private const val MASKED_AMOUNT = "************"

/**
 * 总览 / 资产首页。
 *
 * 移动端只保留高频摘要：总资产、月收支、日常资金、信用卡、投资账户和资金账户。
 * 详细统计与更多筛选交给 Web 工作台。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OverviewScreen(
    onNavigateToSettings: () -> Unit,
    onNavigateToAccounts: () -> Unit,
    onNavigateToFunds: () -> Unit,
    onNavigateToAddTransaction: () -> Unit = {},
    onNavigateToAccountDetail: (String, String) -> Unit = { _, _ -> },
    viewModel: OverviewViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    // 默认隐藏金额，保护隐私；点总资产卡片上的眼睛图标可切换显示。
    var showAmounts by rememberSaveable { mutableStateOf(false) }
    var cashSummaryExpanded by rememberSaveable { mutableStateOf(true) }
    var creditExpanded by rememberSaveable { mutableStateOf(true) }
    var investExpanded by rememberSaveable { mutableStateOf(true) }
    var fixedAssetExpanded by rememberSaveable { mutableStateOf(true) }
    var dailyExpanded by rememberSaveable { mutableStateOf(true) }

    LaunchedEffect(Unit) { viewModel.loadOverview() }

    if (uiState.isLoading && uiState.netWorth == 0.0) {
        // 骨架加载态
        SkeletonLoading()
    } else {
        PullToRefreshBox(
            isRefreshing = uiState.isLoading,
            onRefresh = { viewModel.retry() },
            modifier = Modifier.fillMaxSize()
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 92.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    AssetHeaderCard(
                        netWorth = uiState.netWorth,
                        dailyNetWorth = uiState.dailyNetWorth,
                        investmentMarketValue = uiState.investmentMarketValue,
                        liabilities = uiState.accountTypeTotals.liabilities,
                        showAmounts = showAmounts,
                        onToggleShow = { showAmounts = !showAmounts }
                    )
                }

                item {
                    MonthFlowStrip(
                        income = uiState.monthIncome,
                        expense = uiState.monthExpense,
                        showAmounts = showAmounts
                    )
                }

                item {
                    CollapsibleHeader(
                        text = "资金分类",
                        expanded = cashSummaryExpanded,
                        onToggle = { cashSummaryExpanded = !cashSummaryExpanded }
                    )
                }
                if (cashSummaryExpanded) {
                    item {
                        DailySummaryCard(
                            totals = uiState.accountTypeTotals,
                            showAmounts = showAmounts
                        )
                    }
                }

                if (uiState.creditAccountList.isNotEmpty()) {
                    item {
                        CollapsibleHeader(
                            text = "信用卡",
                            expanded = creditExpanded,
                            onToggle = { creditExpanded = !creditExpanded }
                        )
                    }
                    if (creditExpanded) {
                        item {
                            CreditSummaryCard(
                                used = uiState.creditUsedTotal,
                                available = uiState.creditAvailableTotal,
                                currentBill = uiState.creditCurrentBillTotal,
                                showAmounts = showAmounts
                            )
                        }
                    }
                }

                if (uiState.investmentAccountList.isNotEmpty()) {
                    item {
                        CollapsibleHeader(
                            text = "投资账户",
                            expanded = investExpanded,
                            onToggle = { investExpanded = !investExpanded }
                        )
                    }
                    if (investExpanded) {
                        item {
                            InvestmentSummaryCard(
                                totalMarketValue = uiState.investmentMarketValue,
                                totalCost = uiState.investmentCost,
                                floatingPnL = uiState.investmentFloatingPnL,
                                accountCount = uiState.investmentAccountList.size,
                                showAmounts = showAmounts,
                                onClick = onNavigateToFunds
                            )
                        }
                    }
                }

                if (uiState.fixedAssetAccountList.isNotEmpty()) {
                    item {
                        CollapsibleHeader(
                            text = "固定资产",
                            expanded = fixedAssetExpanded,
                            onToggle = { fixedAssetExpanded = !fixedAssetExpanded }
                        )
                    }
                    if (fixedAssetExpanded) {
                        item {
                            FixedAssetSummaryCard(
                                totalMarketValue = uiState.fixedAssetMarketValue,
                                totalCost = uiState.fixedAssetCost,
                                assetCount = uiState.fixedAssetAccountList.size,
                                showAmounts = showAmounts
                            )
                        }
                    }
                }

                if (uiState.dailyAccountList.isNotEmpty()) {
                    item {
                        CollapsibleHeader(
                            text = "资金账户",
                            expanded = dailyExpanded,
                            onToggle = { dailyExpanded = !dailyExpanded }
                        )
                    }
                    if (dailyExpanded) {
                        item {
                            MoneyAccountSummaryCard(
                                totalBalance = uiState.dailyAccountList.sumOf { it.balance },
                                accountCount = uiState.dailyAccountList.size,
                                showAmounts = showAmounts,
                                onClick = onNavigateToAccounts
                            )
                        }
                    }
                }

                uiState.error?.let { msg ->
                    item { ErrorBanner(msg) { viewModel.retry() } }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 总资产头卡
// ─────────────────────────────────────────────────────────────────

@Composable
private fun AssetHeaderCard(
    netWorth: Double,
    dailyNetWorth: Double,
    investmentMarketValue: Double,
    liabilities: Double,
    showAmounts: Boolean,
    onToggleShow: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp)
                .animateContentSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "总资产",
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.weight(1f)
                )
                IconButton(
                    onClick = onToggleShow,
                    modifier = Modifier.size(28.dp)
                ) {
                    Icon(
                        if (showAmounts) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                        contentDescription = if (showAmounts) "隐藏金额" else "显示金额",
                        tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.65f),
                        modifier = Modifier.size(18.dp)
                    )
                }
            }

            Text(
                text = if (showAmounts) formatAmount(netWorth) else MASKED_AMOUNT,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                HeaderMiniMetric("日常", dailyNetWorth, showAmounts, Modifier.weight(1f))
                HeaderMiniMetric("投资", investmentMarketValue, showAmounts, Modifier.weight(1f))
                HeaderMiniMetric("负债", liabilities, showAmounts, Modifier.weight(1f), liability = true)
            }
        }
    }
}

@Composable
private fun HeaderMiniMetric(
    label: String,
    value: Double,
    showAmounts: Boolean,
    modifier: Modifier = Modifier,
    liability: Boolean = false
) {
    Column(modifier = modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.62f),
            maxLines = 1
        )
        Text(
            text = if (showAmounts) formatAmount(value) else MASKED_AMOUNT,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            fontWeight = FontWeight.SemiBold,
            color = if (liability && value > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onPrimaryContainer,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun MonthFlowStrip(
    income: Double,
    expense: Double,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            CompactMetric(
                label = "本月收入",
                value = if (showAmounts) formatAmount(abs(income)) else MASKED_AMOUNT,
                valueColor = Color(0xFF16A34A),
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "本月支出",
                value = if (showAmounts) formatAmount(abs(expense)) else MASKED_AMOUNT,
                valueColor = Color(0xFFDC2626),
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "结余",
                value = if (showAmounts) formatPnl(income - expense) else MASKED_AMOUNT,
                valueColor = pnlColor(income - expense),
                modifier = Modifier.weight(1f),
                alignEnd = true
            )
        }
    }
}

@Composable
private fun DailySummaryCard(
    totals: AccountTypeTotalsDto,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                CompactMetric("现金", displayAmount(totals.cash, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("借记卡", displayAmount(totals.bankDebit, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("第三方", displayAmount(totals.ewallet, showAmounts), modifier = Modifier.weight(1f), alignEnd = true)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                CompactMetric("存款", displayAmount(totals.deposit, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("债权", displayAmount(totals.loanReceivable, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric(
                    "负债",
                    displayAmount(totals.liabilities, showAmounts),
                    valueColor = if (totals.liabilities > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                    alignEnd = true
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                CompactMetric("其他", displayAmount(totals.other, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("流动资产", displayAmount(totals.liquidAssets, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric(
                    "净资产",
                    displayAmount(totals.dailyNetWorth, showAmounts),
                    valueColor = pnlColor(totals.dailyNetWorth),
                    modifier = Modifier.weight(1f),
                    alignEnd = true
                )
            }
        }
    }
}

@Composable
private fun CreditSummaryCard(
    used: Double,
    available: Double,
    currentBill: Double,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            CompactMetric("信用卡已用", displayAmount(used, showAmounts), valueColor = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
            CompactMetric("可用额度", displayAmount(available, showAmounts), modifier = Modifier.weight(1f))
            CompactMetric("本期账单", displayAmount(currentBill, showAmounts), modifier = Modifier.weight(1f), alignEnd = true)
        }
    }
}

/**
 * 投资账户汇总卡：与信用卡汇总卡统一为单行汇总，点击进入账户列表。
 */
@Composable
private fun InvestmentSummaryCard(
    totalMarketValue: Double,
    totalCost: Double,
    floatingPnL: Double,
    accountCount: Int,
    showAmounts: Boolean,
    onClick: () -> Unit
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactMetric(
                label = "市值",
                value = if (showAmounts) formatAmount(totalMarketValue) else MASKED_AMOUNT,
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "成本",
                value = if (showAmounts) formatAmount(totalCost) else MASKED_AMOUNT,
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "浮动盈亏",
                value = if (showAmounts) formatPnl(floatingPnL) else MASKED_AMOUNT,
                valueColor = pnlColor(floatingPnL),
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "$accountCount 个账户",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = Color.Gray,
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

/**
 * 固定资产汇总卡：固定资产（房产、车辆等）已从投资市值中拆出，单独展示。
 */
@Composable
private fun FixedAssetSummaryCard(
    totalMarketValue: Double,
    totalCost: Double,
    assetCount: Int,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactMetric(
                label = "现值",
                value = if (showAmounts) formatAmount(totalMarketValue) else MASKED_AMOUNT,
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "成本",
                value = if (showAmounts) formatAmount(totalCost) else MASKED_AMOUNT,
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "增值",
                value = if (showAmounts) formatPnl(totalMarketValue - totalCost) else MASKED_AMOUNT,
                valueColor = pnlColor(totalMarketValue - totalCost),
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "$assetCount 项",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
            }
        }
    }
}

/**
 * 资金账户汇总卡：显示资金合计与账户数，点击进入账户列表页。
 */
@Composable
private fun MoneyAccountSummaryCard(
    totalBalance: Double,
    accountCount: Int,
    showAmounts: Boolean,
    onClick: () -> Unit
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactMetric(
                label = "资金合计",
                value = if (showAmounts) formatAmount(totalBalance) else MASKED_AMOUNT,
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(6.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "$accountCount 个账户",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = Color.Gray,
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

@Composable
private fun CompactMetric(
    label: String,
    value: String,
    valueColor: Color = MaterialTheme.colorScheme.onSurface,
    modifier: Modifier = Modifier,
    alignEnd: Boolean = false
) {
    Column(
        modifier = modifier,
        horizontalAlignment = if (alignEnd) Alignment.End else Alignment.Start
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
            fontWeight = FontWeight.SemiBold,
            color = valueColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun displayAmount(value: Double, showAmounts: Boolean): String =
    if (showAmounts) formatAmount(value) else MASKED_AMOUNT

// ─────────────────────────────────────────────────────────────────
// 骨架加载态
// ─────────────────────────────────────────────────────────────────

@Composable
private fun SkeletonLoading() {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Card(
                modifier = Modifier.fillMaxWidth().height(180.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.3f))
            ) {}
        }
        item {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(2) {
                    Card(
                        modifier = Modifier.weight(1f).height(90.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                    ) {}
                }
            }
        }
        item {
            Card(
                modifier = Modifier.fillMaxWidth().height(200.dp),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {}
        }
        repeat(4) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth().height(64.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                ) {}
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 辅助组件
// ─────────────────────────────────────────────────────────────────

@Composable
private fun CollapsibleHeader(
    text: String,
    expanded: Boolean,
    onToggle: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .padding(vertical = 6.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f)
        )
        Icon(
            imageVector = if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
            contentDescription = if (expanded) "收起" else "展开",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp)
        )
    }
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
