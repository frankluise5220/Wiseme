package com.mmh.app.ui.transactions

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mmh.app.data.remote.dto.TransactionItemDto
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * Transaction list screen showing all transactions for a given account.
 *
 * 账户详情页使用稳定主键 `accountId` 拉取系统详情接口，`accountName` 仅用于显示。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionListScreen(
    accountId: String,
    accountName: String,
    onBack: () -> Unit,
    onNavigateToCreate: (initialType: String) -> Unit = {},
    onEditTransaction: (transactionId: String) -> Unit = {},
    viewModel: TransactionListViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(accountId) {
        viewModel.loadTransactions(accountId = accountId, accountName = accountName)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = accountName,
                            style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (!uiState.isLoading) {
                            Text(
                                text = "${uiState.totalCount} 笔记录",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { onNavigateToCreate("expense") },
                containerColor = MaterialTheme.colorScheme.primary
            ) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = "新增交易",
                    tint = MaterialTheme.colorScheme.onPrimary
                )
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            when {
                uiState.isLoading && uiState.transactions.isEmpty() -> {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        repeat(6) {
                            Card(
                                modifier = Modifier.fillMaxWidth(),
                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                                elevation = CardDefaults.cardElevation(defaultElevation = 0.5.dp)
                            ) {
                                Column(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 14.dp)
                                ) {
                                    Surface(
                                        modifier = Modifier
                                            .fillMaxWidth(0.35f)
                                            .height(16.dp),
                                        color = MaterialTheme.colorScheme.surfaceVariant,
                                        shape = MaterialTheme.shapes.small,
                                        content = {}
                                    )
                                    Spacer(modifier = Modifier.height(10.dp))
                                    Surface(
                                        modifier = Modifier
                                            .fillMaxWidth(0.6f)
                                            .height(12.dp),
                                        color = MaterialTheme.colorScheme.surfaceVariant,
                                        shape = MaterialTheme.shapes.small,
                                        content = {}
                                    )
                                }
                            }
                        }
                    }
                }

                uiState.error != null -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.CloudOff,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = uiState.error ?: "加载失败",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        OutlinedButton(onClick = { viewModel.refresh() }) {
                            Text("重试")
                        }
                    }
                }

                uiState.transactions.isEmpty() -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.ReceiptLong,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = "暂无交易记录",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        OutlinedButton(onClick = { onNavigateToCreate("expense") }) {
                            Icon(Icons.Default.Add, contentDescription = null)
                            Spacer(Modifier.width(4.dp))
                            Text("新增第一笔交易")
                        }
                    }
                }

                else -> {
                    val groupedByDate = uiState.transactions
                        .groupBy { formatDate(it.date) }

                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        if (uiState.isLoading) {
                            item(key = "loading_indicator") {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 4.dp, vertical = 8.dp),
                                    horizontalArrangement = Arrangement.Center,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = "正在切换账户...",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }

                        groupedByDate.forEach { (dateLabel, transactions) ->
                            item(key = "date_$dateLabel") {
                                DateSectionHeader(dateLabel = dateLabel, count = transactions.size)
                            }

                            items(items = transactions, key = { it.id }) { tx ->
                                TransactionRow(
                                    transaction = tx,
                                    onEdit = {
                                        val recordId = tx.transactionId.ifEmpty { tx.id }
                                        onEditTransaction(recordId)
                                    },
                                    onDelete = {
                                        viewModel.deleteTransaction(tx)
                                    }
                                )
                            }
                        }

                        item { Spacer(modifier = Modifier.height(80.dp)) }
                    }
                }
            }
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
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
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
    transaction: TransactionItemDto,
    onEdit: () -> Unit = {},
    onDelete: () -> Unit = {}
) {
    var showMenu by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.5.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TransactionTypeIcon(type = transaction.type)

            Spacer(modifier = Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = transaction.categoryName.ifEmpty { transaction.type },
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (!transaction.note.isNullOrEmpty()) {
                    Text(
                        text = transaction.note,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            Spacer(modifier = Modifier.width(8.dp))

            Text(
                text = formatTxAmount(transaction.amount, transaction.type),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
                fontWeight = FontWeight.SemiBold,
                color = getAmountColor(transaction.type)
            )

            Box {
                IconButton(onClick = { showMenu = true }) {
                    Icon(
                        imageVector = Icons.Default.MoreVert,
                        contentDescription = "更多操作",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false }
                ) {
                    DropdownMenuItem(
                        text = { Text("编辑") },
                        onClick = {
                            showMenu = false
                            onEdit()
                        },
                        leadingIcon = {
                            Icon(Icons.Default.Edit, contentDescription = null)
                        }
                    )
                    DropdownMenuItem(
                        text = { Text("删除", color = MaterialTheme.colorScheme.error) },
                        onClick = {
                            showMenu = false
                            onDelete()
                        },
                        leadingIcon = {
                            Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                        }
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
    Icon(imageVector = icon, contentDescription = type, tint = tint, modifier = Modifier.size(24.dp))
}

@Composable
private fun getAmountColor(type: String): Color = when (type) {
    "expense" -> Color(0xFFDC2626)
    "income" -> Color(0xFF16A34A)
    "transfer" -> Color(0xFF2563EB)
    "investment" -> Color(0xFF7C3AED)
    else -> MaterialTheme.colorScheme.onSurface
}

private fun formatTxAmount(amount: Double, type: String): String {
    val prefix = when (type) {
        "expense", "transfer" -> "-"
        "income" -> "+"
        else -> ""
    }
    return "$prefix¥${String.format("%.2f", kotlin.math.abs(amount))}"
}

private fun formatDate(isoDate: String): String {
    return try {
        val dateStr = if (isoDate.contains("T")) isoDate.substringBefore("T") else isoDate
        val date = LocalDate.parse(dateStr)
        val today = LocalDate.now()
        val yesterday = today.minusDays(1)
        when {
            date == today -> "今天"
            date == yesterday -> "昨天"
            date.year == today.year -> date.format(DateTimeFormatter.ofPattern("M月d日"))
            else -> date.format(DateTimeFormatter.ofPattern("yyyy年M月d日"))
        }
    } catch (e: Exception) {
        isoDate.substringBefore("T")
    }
}
