package com.mmh.app.ui.transactions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.TransactionItemDto
import com.mmh.app.ui.util.formatAccountDisplayName
import com.mmh.app.ui.util.formatDateRelative

/**
 * 流水 Tab 主页：跨账户近期交易流水列表。
 * 使用独立的 `TransactionRecentViewModel` 获取全量近期流水，避免和账户详情页共享状态。
 */
@Composable
fun TransactionRecentScreen(
    onNavigateToCreate: (initialType: String) -> Unit = {},
    onEditTransaction: (transactionId: String) -> Unit = {},
    onNavigateToAccountDetail: (accountId: String, accountName: String) -> Unit = { _, _ -> },
    viewModel: TransactionRecentViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.loadTransactions()
    }

    Box(modifier = Modifier.fillMaxSize()) {
        when {
            uiState.isLoading -> {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            uiState.error != null && uiState.transactions.isEmpty() -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(
                        Icons.Default.CloudOff, contentDescription = null,
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(uiState.error!!, color = MaterialTheme.colorScheme.error)
                    Spacer(modifier = Modifier.height(16.dp))
                    OutlinedButton(onClick = { viewModel.refresh() }) { Text("重试") }
                }
            }

            uiState.transactions.isEmpty() -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(
                        Icons.Default.ReceiptLong, contentDescription = null,
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("暂无交易记录", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            else -> {
                val groupedByDate = uiState.transactions
                    .groupBy { formatDateRelative(it.date) }

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp, end = 16.dp,
                        top = 8.dp, bottom = 80.dp
                    )
                ) {
                    groupedByDate.forEach { (dateLabel, txs) ->
                        item(key = "date_$dateLabel") {
                            DateSectionHeader(dateLabel, txs.size)
                        }
                        items(txs, key = { it.id }) { tx ->
                            TransactionRow(
                                tx = tx,
                                onEdit = {
                                    val recordId = tx.transactionId.ifEmpty { tx.id }
                                    onEditTransaction(recordId)
                                },
                                onDelete = { viewModel.deleteTransaction(tx) },
                                onAccountClick = {
                                    val targetAccountId = tx.accountId.ifBlank { tx.toAccountId.orEmpty() }
                                    val targetAccountName = tx.displayAccountName().ifBlank { tx.displayToAccountName() }
                                    if (targetAccountId.isNotBlank() && targetAccountName.isNotBlank()) {
                                        onNavigateToAccountDetail(targetAccountId, targetAccountName)
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }

        // FAB 记一笔
        FloatingActionButton(
            onClick = { onNavigateToCreate("expense") },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp),
            containerColor = MaterialTheme.colorScheme.primary
        ) {
            Icon(Icons.Default.Add, contentDescription = "记一笔", tint = MaterialTheme.colorScheme.onPrimary)
        }
    }
}

@Composable
private fun DateSectionHeader(dateLabel: String, count: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = dateLabel,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "$count 笔",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.weight(1f))
        HorizontalDivider(
            modifier = Modifier.weight(1f),
            color = MaterialTheme.colorScheme.outlineVariant
        )
    }
}

@Composable
private fun TransactionRow(
    tx: TransactionItemDto,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onAccountClick: () -> Unit
) {
    var showMenu by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.5.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TransactionTypeIcon(type = tx.type)

            Spacer(modifier = Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = tx.categoryName.ifEmpty { tx.type },
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val accountDisplayName = tx.displayAccountName()
                    if (accountDisplayName.isNotBlank()) {
                        Text(
                            text = accountDisplayName,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable { onAccountClick() }
                        )
                    }
                    if (!tx.note.isNullOrEmpty()) {
                        if (accountDisplayName.isNotBlank()) {
                            Text(
                                " · ",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Text(
                            text = tx.note,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.width(8.dp))

            Text(
                text = formatTxAmount(tx.amount, tx.type),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = getAmountColor(tx.type)
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onEdit) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = "编辑",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
                IconButton(onClick = onDelete) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "删除",
                        tint = MaterialTheme.colorScheme.error
                    )
                }
            }
        }
    }
}

@Composable
private fun TransactionTypeIcon(type: String) {
    val (icon, tint) = when (type) {
        "expense" -> Icons.Default.ShoppingCart to Color(0xFFDC2626)
        "income" -> Icons.Default.TrendingUp to Color(0xFF16A34A)
        "transfer" -> Icons.Default.SwapHoriz to Color(0xFF2563EB)
        "investment" -> Icons.Default.ShowChart to Color(0xFF7C3AED)
        else -> Icons.Default.Circle to Color(0xFF94A3B8)
    }
    Icon(icon, contentDescription = type, tint = tint, modifier = Modifier.size(24.dp))
}

@Composable
private fun getAmountColor(type: String): Color = when (type) {
    "expense" -> Color(0xFFDC2626)
    "income" -> Color(0xFF16A34A)
    "transfer" -> Color(0xFF2563EB)
    "investment" -> Color(0xFF7C3AED)
    else -> MaterialTheme.colorScheme.onSurface
}

private fun TransactionItemDto.displayAccountName(): String =
    formatAccountDisplayName(accountName, accountInstitutionName)

private fun TransactionItemDto.displayToAccountName(): String =
    formatAccountDisplayName(toAccountName.orEmpty(), toAccountInstitutionName)

private fun formatTxAmount(amount: Double, type: String): String {
    val prefix = when (type) {
        "expense", "transfer" -> "-"
        "income" -> "+"
        else -> ""
    }
    val abs = kotlin.math.abs(amount)
    return "$prefix¥${String.format("%.2f", abs)}"
}
