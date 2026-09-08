package com.mmh.app.ui.invest

import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatPnl
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvestOverviewScreen(
    showTopBar: Boolean = true,
    onBack: (() -> Unit)? = null,
    onAccountClick: (accountId: String, investProductType: String) -> Unit = { _, _ -> },
    viewModel: InvestOverviewViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }

    if (showTopBar) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("\u6295\u8d44\u603b\u89c8") },
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
                isRefreshing = uiState.isLoading,
                onRefresh = { viewModel.load() },
                modifier = Modifier.fillMaxSize()
            ) {
                Content(uiState, viewModel, onAccountClick, Modifier.padding(padding))
            }
        }
    } else {
        PullToRefreshBox(
            isRefreshing = uiState.isLoading,
            onRefresh = { viewModel.load() },
            modifier = Modifier.fillMaxSize()
        ) {
            Content(uiState, viewModel, onAccountClick, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun Content(
    uiState: InvestOverviewUiState,
    viewModel: InvestOverviewViewModel,
    onAccountClick: (accountId: String, investProductType: String) -> Unit,
    modifier: Modifier = Modifier
) {
    var hideZeroAccounts by rememberSaveable { mutableStateOf(true) }
    val visibleAccounts = if (hideZeroAccounts) {
        uiState.accounts.filterNot { it.isZeroAccount() }
    } else {
        uiState.accounts
    }

    when {
        uiState.isLoading && uiState.accounts.isEmpty() -> {
            Box(
                modifier = modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) { CircularProgressIndicator() }
        }

        uiState.error != null -> {
            Column(
                modifier = modifier.fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(uiState.error, color = MaterialTheme.colorScheme.error)
                Spacer(modifier = Modifier.height(8.dp))
                TextButton(onClick = { viewModel.load() }) { Text("\u91cd\u8bd5") }
            }
        }

        else -> {
            Column(
                modifier = modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                SummaryCard(
                    totalMarketValue = uiState.totalMarketValue,
                    totalCost = uiState.totalCost,
                    floatingPnL = uiState.floatingPnL
                )

                SectionHeader(
                    hideZeroAccounts = hideZeroAccounts,
                    onToggleZeroAccounts = { hideZeroAccounts = !hideZeroAccounts }
                )

                if (visibleAccounts.isEmpty()) {
                    EmptyHint("\u6682\u65e0\u6295\u8d44\u8d26\u6237")
                } else {
                    visibleAccounts.forEach { account ->
                        InvestmentAccountCard(
                            account = account,
                            onClick = { onAccountClick(account.accountId, account.investProductType) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(hideZeroAccounts: Boolean, onToggleZeroAccounts: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = "\u6295\u8d44\u8d26\u6237",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface
        )
        TextButton(onClick = onToggleZeroAccounts) {
            Text(if (hideZeroAccounts) "\u663e\u793a\u96f6\u503c" else "\u9690\u85cf\u96f6\u503c")
        }
    }
}

@Composable
private fun SummaryCard(
    totalMarketValue: Double,
    totalCost: Double,
    floatingPnL: Double
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Text(
                text = "\u6295\u8d44\u8d26\u6237\u603b\u5e02\u503c",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f)
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = formatAmount(totalMarketValue),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimary
            )
            Spacer(modifier = Modifier.height(16.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                SummaryColumn("\u6301\u4ed3\u6210\u672c", formatAmount(totalCost))
                SummaryColumn("\u6d6e\u52a8\u76c8\u4e8f", formatPnl(floatingPnL))
            }
        }
    }
}

@Composable
private fun SummaryColumn(label: String, value: String) {
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f)
        )
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onPrimary
        )
    }
}

@Composable
private fun InvestmentAccountCard(account: InvestmentAccountOverviewRow, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(13.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 11.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.Default.AccountBalanceWallet,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp)
                )
                Spacer(modifier = Modifier.width(9.dp))
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.Bottom
                ) {
                    Text(
                        text = account.accountName,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "${account.positionCount} \u4e2a\u6301\u4ed3",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                AccountMetric(
                    label = "\u6210\u672c",
                    value = formatAmount(account.totalCost),
                    modifier = Modifier.weight(1f)
                )
                AccountMetric(
                    label = "\u5e02\u503c",
                    value = formatAmount(account.marketValue),
                    modifier = Modifier.weight(1f)
                )
                AccountMetric(
                    label = "\u76c8\u4e8f",
                    value = formatPnl(account.floatingPnL),
                    modifier = Modifier.weight(1f),
                    valueColor = if (account.floatingPnL >= 0) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.primary
                    }
                )
            }
        }
    }
}

@Composable
private fun AccountMetric(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    valueColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.Start
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
            fontWeight = FontWeight.SemiBold,
            color = valueColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun InvestmentAccountOverviewRow.isZeroAccount(): Boolean =
    abs(marketValue) < 0.005 && abs(totalCost) < 0.005 && abs(floatingPnL) < 0.005

@Composable
private fun EmptyHint(text: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
