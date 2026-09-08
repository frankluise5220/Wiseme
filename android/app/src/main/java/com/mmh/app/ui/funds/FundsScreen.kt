package com.mmh.app.ui.funds

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.TrendingUp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mmh.app.data.remote.dto.FundClearedPositionDto
import com.mmh.app.data.remote.dto.FundEntryDto
import com.mmh.app.data.remote.dto.FundPositionDto
import com.mmh.app.data.remote.dto.InvestmentAccountDto
import com.mmh.app.ui.theme.LocalDisplayPreferences
import com.mmh.app.ui.util.formatAccountDisplayName
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatPnl
import com.mmh.app.ui.util.formatRate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FundsScreen(
    showTopBar: Boolean = true,
    initialSelectedAccountId: String = "",
    onBack: (() -> Unit)? = null,
    onFundClick: (accountId: String, fundCode: String) -> Unit = { _, _ -> },
    onEntryClick: (entryId: String) -> Unit = {},
    viewModel: FundsViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(initialSelectedAccountId) {
        if (initialSelectedAccountId.isNotBlank()) {
            viewModel.selectAccount(initialSelectedAccountId)
        }
    }

    if (showTopBar) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("\u57fa\u91d1\u6301\u4ed3", style = MaterialTheme.typography.titleMedium) },
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "\u8fd4\u56de")
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    )
                )
            }
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = uiState.isRefreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier.fillMaxSize()
            ) {
                FundsContent(uiState, viewModel, onFundClick, onEntryClick, Modifier.padding(padding))
            }
        }
    } else {
        PullToRefreshBox(
            isRefreshing = uiState.isRefreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize()
        ) {
            FundsContent(uiState, viewModel, onFundClick, onEntryClick, Modifier.fillMaxSize())
        }
    }
}

private enum class FundListKind {
    Active,
    Cleared
}

@Composable
private fun FundsContent(
    uiState: FundsUiState,
    viewModel: FundsViewModel,
    onFundClick: (accountId: String, fundCode: String) -> Unit,
    onEntryClick: (entryId: String) -> Unit,
    modifier: Modifier = Modifier
) {
    var listKind by remember { mutableStateOf(FundListKind.Active) }

    when {
        uiState.isLoading && uiState.accounts.isEmpty() -> {
            Box(
                modifier = modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) { CircularProgressIndicator() }
        }

        uiState.error != null && uiState.accounts.isEmpty() -> {
            ErrorState(
                modifier = modifier,
                message = uiState.error ?: "\u52a0\u8f7d\u5931\u8d25",
                onRetry = viewModel::loadInitial,
            )
        }

        else -> {
            LazyColumn(
                modifier = modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    AccountPicker(
                        accountOptions = uiState.accounts,
                        selectedAccountId = uiState.selectedAccountId,
                        onSelect = viewModel::selectAccount,
                    )
                }

                item {
                    FundSummaryCard(
                        totalMarketValue = uiState.totalMarketValue,
                        totalCost = uiState.totalCost,
                        floatingPnL = uiState.totalMarketValue - uiState.totalCost,
                    )
                }

                if (uiState.isRefreshing) {
                    item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                }

                if (uiState.error != null && uiState.positions.isNotEmpty()) {
                    item {
                        Text(
                            text = uiState.error ?: "",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                }

                item {
                    FundListSwitch(
                        selected = listKind,
                        activeCount = uiState.positions.size,
                        clearedCount = uiState.clearedPositions.size,
                        onSelect = { nextKind ->
                            listKind = nextKind
                            val selectedExists = when (nextKind) {
                                FundListKind.Active -> uiState.positions.any { it.fundCode == uiState.selectedFundCode }
                                FundListKind.Cleared -> uiState.clearedPositions.any { it.fundCode == uiState.selectedFundCode }
                            }
                            if (!selectedExists) {
                                val nextFundCode = when (nextKind) {
                                    FundListKind.Active -> uiState.positions.firstOrNull()?.fundCode
                                    FundListKind.Cleared -> uiState.clearedPositions.firstOrNull()?.fundCode
                                }
                                if (!nextFundCode.isNullOrBlank()) viewModel.selectFund(nextFundCode)
                            }
                        }
                    )
                }

                when (listKind) {
                    FundListKind.Active -> {
                        if (uiState.positions.isEmpty()) {
                            item { EmptyFundsState("\u5f53\u524d\u8d26\u6237\u8fd8\u6ca1\u6709\u57fa\u91d1\u6301\u4ed3") }
                        } else {
                            items(uiState.positions, key = { it.fundCode }) { position ->
                                FundPositionRow(
                                    position = position,
                                    selected = uiState.selectedFundCode == position.fundCode,
                                    onClick = {
                                        viewModel.selectFund(position.fundCode)
                                        onFundClick(uiState.selectedAccountId, position.fundCode)
                                    },
                                )
                            }

                            SelectedFundEntries(
                                entries = uiState.entries,
                                selectedFundCode = uiState.selectedFundCode,
                                onEntryClick = onEntryClick,
                            )
                        }
                    }

                    FundListKind.Cleared -> {
                        if (uiState.clearedPositions.isEmpty()) {
                            item { EmptyFundsState("\u6682\u65e0\u5df2\u6e05\u4ed3\u57fa\u91d1") }
                        } else {
                            items(uiState.clearedPositions, key = { it.fundCode }) { position ->
                                ClearedFundPositionRow(
                                    position = position,
                                    selected = uiState.selectedFundCode == position.fundCode,
                                    onClick = { viewModel.selectFund(position.fundCode) }
                                )
                            }

                            SelectedFundEntries(
                                entries = uiState.entries,
                                selectedFundCode = uiState.selectedFundCode,
                                onEntryClick = onEntryClick,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun LazyListScope.SelectedFundEntries(
    entries: List<FundEntryDto>,
    selectedFundCode: String,
    onEntryClick: (entryId: String) -> Unit,
) {
    val filteredEntries = entries.filter { entry ->
        selectedFundCode.isBlank() || entry.fundCode == selectedFundCode
    }

    if (filteredEntries.isNotEmpty()) {
        item {
            Text(
                text = "相关记录",
                style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
                fontWeight = FontWeight.SemiBold
            )
        }

        items(filteredEntries.take(8), key = { it.id }) { entry ->
            FundEntryRow(
                entry = entry,
                onClick = { onEntryClick(entry.id) }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccountPicker(
    accountOptions: List<InvestmentAccountDto>,
    selectedAccountId: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = accountOptions.firstOrNull { it.id == selectedAccountId }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = !expanded }
    ) {
        OutlinedTextField(
            value = selected?.displayName() ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text("\u6295\u8d44\u8d26\u6237") },
            placeholder = { Text("\u8bf7\u9009\u62e9\u6295\u8d44\u8d26\u6237") },
            leadingIcon = {
                Icon(Icons.Default.AccountBalanceWallet, contentDescription = null)
            },
            trailingIcon = {
                ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded)
            },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor()
        )

        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            accountOptions.forEach { account ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(account.displayName())
                            Text(
                                text = "${account.investProductType}  ${formatAmount(account.balance)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(account.id)
                    }
                )
            }
        }
    }
}

@Composable
private fun FundSummaryCard(
    totalMarketValue: Double,
    totalCost: Double,
    floatingPnL: Double,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "\u6301\u4ed3\u603b\u89c8",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
            Text(
                text = formatAmount(totalMarketValue),
                style = MaterialTheme.typography.headlineSmall.copy(fontSize = 26.sp),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SummaryMetric("成本", formatAmount(totalCost))
                SummaryMetric("浮动盈亏", formatPnl(floatingPnL))
            }
        }
    }
}

@Composable
private fun SummaryMetric(label: String, value: String) {
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
            color = MaterialTheme.colorScheme.onPrimaryContainer
        )
    }
}

@Composable
private fun FundListSwitch(
    selected: FundListKind,
    activeCount: Int,
    clearedCount: Int,
    onSelect: (FundListKind) -> Unit,
) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(
            selected = selected == FundListKind.Active,
            onClick = { onSelect(FundListKind.Active) },
            label = { Text("\u5f53\u524d\u6301\u4ed3 $activeCount", fontSize = 12.sp) }
        )
        FilterChip(
            selected = selected == FundListKind.Cleared,
            onClick = { onSelect(FundListKind.Cleared) },
            label = { Text("\u5df2\u6e05\u4ed3 $clearedCount", fontSize = 12.sp) }
        )
    }
}

@Composable
private fun FundPositionRow(
    position: FundPositionDto,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val displayPreferences = LocalDisplayPreferences.current
    val floatingColor = if (position.floatingPnL >= 0) displayPreferences.upColor else displayPreferences.downColor
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 11.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = position.displayName(),
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = position.fundCode,
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    softWrap = false
                )
            }

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                PositionMetric("成本", formatAmount(position.cost), modifier = Modifier.weight(0.82f))
                PositionMetric("市值", formatAmount(position.marketValue), valueColor = floatingColor, modifier = Modifier.weight(0.9f))
                FloatingPnlMetric(
                    pnl = position.floatingPnL,
                    pnlRate = position.floatingPnLRate,
                    valueColor = floatingColor,
                    modifier = Modifier.weight(1.45f)
                )
            }
        }
    }
}

@Composable
private fun ClearedFundPositionRow(
    position: FundClearedPositionDto,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 11.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = position.displayName(),
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = position.fundCode,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = formatPnl(position.historicalProfit),
                    style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
                    fontWeight = FontWeight.Bold,
                    color = if (position.historicalProfit >= 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
                )
            }

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                PositionMetric("\u4e70\u5165", formatAmount(position.totalBuyAmount))
                PositionMetric("\u56de\u6536", formatAmount(position.totalRedeemAmount))
                PositionMetric("\u6e05\u4ed3\u65e5", position.clearedDate.ifBlank { "-" })
            }
        }
    }
}

@Composable
private fun PositionMetric(
    label: String,
    value: String,
    valueColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface,
    modifier: Modifier = Modifier,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start
) {
    Column(modifier = modifier, horizontalAlignment = horizontalAlignment) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
            fontWeight = FontWeight.Medium,
            color = valueColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Clip
        )
    }
}

@Composable
private fun FloatingPnlMetric(
    pnl: Double,
    pnlRate: Double?,
    valueColor: Color,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.End) {
        Text(
            text = "浮盈",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.End
        ) {
            Text(
                text = formatPnl(pnl),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                fontWeight = FontWeight.Medium,
                color = valueColor,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Clip
            )
            pnlRate?.let {
                Spacer(modifier = Modifier.width(2.dp))
                Text(
                    text = "(${formatRate(it)})",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                    color = valueColor.copy(alpha = 0.82f),
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Clip
                )
            }
        }
    }
}

@Composable
private fun FundEntryRow(entry: FundEntryDto, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = entry.date,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1.1f)
            )
            Text(
                text = formatAmount(entry.amount),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = entry.unitsText(),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(0.8f)
            )
        }
    }
}

@Composable
private fun EmptyFundsState(text: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                imageVector = Icons.Default.TrendingUp,
                contentDescription = null,
                modifier = Modifier.size(40.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

@Composable
private fun ErrorState(
    modifier: Modifier = Modifier,
    message: String,
    onRetry: () -> Unit,
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                imageVector = Icons.Default.CloudOff,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(text = message, color = MaterialTheme.colorScheme.error)
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedButton(onClick = onRetry) { Text("\u91cd\u8bd5") }
        }
    }
}

private fun FundPositionDto.displayName(): String = fundName.ifBlank { name.ifBlank { fundCode } }

private fun FundClearedPositionDto.displayName(): String = fundName.ifBlank { name.ifBlank { fundCode } }

private fun InvestmentAccountDto.displayName(): String = formatAccountDisplayName(name, institutionName)

private fun FundEntryDto.unitsText(): String = (fundUnits ?: shares)?.let { formatNumber(it) } ?: "-"

private fun formatNumber(value: Double): String = "%.2f".format(value)
