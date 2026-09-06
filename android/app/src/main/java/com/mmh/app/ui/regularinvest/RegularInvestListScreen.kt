package com.mmh.app.ui.regularinvest

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.RegularInvestPlanDto
import com.mmh.app.data.remote.dto.UpdateRegularInvestRequest
import com.mmh.app.ui.util.formatAccountDisplayName
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatDate

/**
 * 定投计划列表页。按状态分组：进行中（再按下次执行日升序）/ 已暂停 / 已停止。
 * 列表项支持暂停 / 恢复 / 停止 / 删除。
 * 数据来自 GET /api/v1/regular-invest，与网页定投页同源。
 *
 * @param showTopBar 是否显示顶栏（投资 Tab 内为 false，独立详情页为 true）
 * @param onBack 独立详情页返回回调（无顶栏时为 null）
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RegularInvestListScreen(
    showTopBar: Boolean = true,
    onBack: (() -> Unit)? = null,
    filterFundCode: String = "",
    viewModel: RegularInvestViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var editingPlan by remember { mutableStateOf<RegularInvestPlanDto?>(null) }

    // toast → Snackbar
    LaunchedEffect(uiState.toast) {
        uiState.toast?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearToast()
        }
    }

    // 分组：进行中 / 已暂停 / 已停止
    val active = remember(uiState.plans) {
        uiState.plans.filter { it.status == "active" }
            .sortedBy { it.nextRunDate.ifEmpty { "9999" } }
    }
    val paused = remember(uiState.plans) { uiState.plans.filter { it.status == "paused" } }
    val stopped = remember(uiState.plans) { uiState.plans.filter { it.status == "stopped" } }

    if (showTopBar) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text("定投计划") },
                    navigationIcon = {
                        if (onBack != null) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    )
                )
            },
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            PullToRefreshBox(
                isRefreshing = uiState.isLoading,
                onRefresh = { viewModel.loadPlans() },
                modifier = Modifier.fillMaxSize()
            ) {
                PlanListContent(
                    uiState = uiState,
                    viewModel = viewModel,
                    modifier = Modifier.padding(padding),
                    filterFundCode = filterFundCode,
                    onEditPlan = { editingPlan = it }
                )
            }
        }
    } else {
        Box(modifier = Modifier.fillMaxSize()) {
            PullToRefreshBox(
                isRefreshing = uiState.isLoading,
                onRefresh = { viewModel.loadPlans() },
                modifier = Modifier.fillMaxSize()
            ) {
                PlanListContent(
                    uiState = uiState,
                    viewModel = viewModel,
                    modifier = Modifier.fillMaxSize(),
                    filterFundCode = filterFundCode,
                    onEditPlan = { editingPlan = it }
                )
            }
            // embedded mode: snackbar host inline
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
    }

    editingPlan?.let { plan ->
        RegularInvestEditDialog(
            plan = plan,
            isSaving = uiState.actionLoadingId == plan.id,
            onDismiss = { if (uiState.actionLoadingId != plan.id) editingPlan = null },
            onSave = { request ->
                viewModel.updatePlan(request) {
                    editingPlan = null
                }
            }
        )
    }
}

@Composable
private fun PlanListContent(
    uiState: RegularInvestUiState,
    viewModel: RegularInvestViewModel,
    modifier: Modifier = Modifier,
    filterFundCode: String = "",
    onEditPlan: (RegularInvestPlanDto) -> Unit = {}
) {
    val displayPlans = remember(uiState.plans, filterFundCode) {
        if (filterFundCode.isBlank()) uiState.plans else uiState.plans.filter { it.fundCode == filterFundCode }
    }
    val active = remember(displayPlans) {
        displayPlans.filter { it.status == "active" }
            .sortedBy { it.nextRunDate.ifEmpty { "9999" } }
    }
    val paused = remember(displayPlans) { displayPlans.filter { it.status == "paused" } }
    val stopped = remember(displayPlans) { displayPlans.filter { it.status == "stopped" } }

    when {
        uiState.isLoading && displayPlans.isEmpty() -> {
            Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }

        uiState.error != null && displayPlans.isEmpty() -> {
            Column(
                modifier = modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(text = uiState.error!!, color = MaterialTheme.colorScheme.error)
                Spacer(modifier = Modifier.height(8.dp))
                TextButton(onClick = { viewModel.loadPlans() }) { Text("重试") }
            }
        }

        displayPlans.isEmpty() -> {
            Column(
                modifier = modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Icon(
                    Icons.Default.Repeat, contentDescription = null,
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text("暂无定投计划", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        else -> {
            LazyColumn(
                modifier = modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (active.isNotEmpty()) {
                    item { GroupHeader("进行中（${active.size}）") }
                    items(active, key = { it.id }) { plan ->
                        PlanCard(plan, uiState.actionLoadingId == plan.id, viewModel, onEditPlan)
                    }
                }
                if (paused.isNotEmpty()) {
                    item { GroupHeader("已暂停（${paused.size}）") }
                    items(paused, key = { it.id }) { plan ->
                        PlanCard(plan, uiState.actionLoadingId == plan.id, viewModel, onEditPlan)
                    }
                }
                if (stopped.isNotEmpty()) {
                    item { GroupHeader("已停止（${stopped.size}）") }
                    items(stopped, key = { it.id }) { plan ->
                        PlanCard(plan, uiState.actionLoadingId == plan.id, viewModel, onEditPlan)
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 4.dp, bottom = 2.dp)
    )
}

private fun RegularInvestPlanDto.displayPlanName(): String =
    planName?.takeIf { it.isNotBlank() } ?: fundName.ifEmpty { fundCode }

@Composable
private fun PlanCard(
    plan: RegularInvestPlanDto,
    loading: Boolean,
    viewModel: RegularInvestViewModel,
    onEditPlan: (RegularInvestPlanDto) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = plan.displayPlanName(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f)
                )
                StatusChip(plan.status)
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "${formatAmount(plan.amount)} · ${intervalText(plan)}",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Medium
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                InfoLine("下次执行", formatDate(plan.nextRunDate))
                InfoLine(
                    "已执行",
                    "${plan.executedRuns}${plan.totalRuns?.let { "/$it" } ?: ""} 次"
                )
                InfoLine("资金账户", plan.cashAccountDisplayName())
            }

            Spacer(modifier = Modifier.height(12.dp))
            HorizontalDivider()
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ActionButton(
                    contentDescription = "编辑",
                    icon = Icons.Default.Edit,
                    loading = false,
                    onClick = { onEditPlan(plan) },
                )
                when (plan.status) {
                    "active" -> ActionButton(
                        contentDescription = "暂停",
                        icon = Icons.Default.Pause,
                        loading = loading,
                        onClick = { viewModel.pause(plan.id) },
                    )
                    "paused" -> ActionButton(
                        contentDescription = "启动",
                        icon = Icons.Default.PlayArrow,
                        loading = loading,
                        onClick = { viewModel.resume(plan.id) },
                    )
                    else -> ActionButton(
                        contentDescription = "已停止",
                        icon = Icons.Default.Stop,
                        loading = false,
                        onClick = {},
                        enabled = false
                    )
                }
                ActionButton(
                    contentDescription = "删除",
                    icon = Icons.Default.Delete,
                    loading = loading,
                    onClick = { viewModel.delete(plan.id) },
                    danger = true,
                )
            }
        }
    }
}

@Composable
private fun RegularInvestEditDialog(
    plan: RegularInvestPlanDto,
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onSave: (UpdateRegularInvestRequest) -> Unit
) {
    var planName by remember(plan.id) { mutableStateOf(plan.planName.orEmpty()) }
    var amount by remember(plan.id) { mutableStateOf(trimNumber(plan.amount)) }
    var intervalUnit by remember(plan.id) { mutableStateOf(plan.intervalUnit.ifBlank { "month" }) }
    var intervalValue by remember(plan.id) { mutableStateOf(plan.intervalValue.toString()) }
    var startDate by remember(plan.id) { mutableStateOf(plan.startDate.substringBefore("T")) }
    var nextRunDate by remember(plan.id) { mutableStateOf(plan.nextRunDate.substringBefore("T")) }
    var endDate by remember(plan.id) { mutableStateOf(plan.endDate?.substringBefore("T").orEmpty()) }
    var totalRuns by remember(plan.id) { mutableStateOf(plan.totalRuns?.toString().orEmpty()) }
    var executionDay by remember(plan.id) { mutableStateOf(plan.executionDay?.toString().orEmpty()) }
    var feeRate by remember(plan.id) { mutableStateOf(plan.feeRate?.let(::trimNumber).orEmpty()) }
    var confirmDays by remember(plan.id) { mutableStateOf(plan.confirmDays?.toString().orEmpty()) }
    var arrivalDays by remember(plan.id) { mutableStateOf(plan.arrivalDays?.toString().orEmpty()) }
    var memo by remember(plan.id) { mutableStateOf(plan.memo.orEmpty()) }
    var skipPendingPreceding by remember(plan.id) { mutableStateOf(plan.skipPendingPreceding) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑定投计划") },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(
                    text = "${plan.fundCode} ${plan.fundName}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                EditTextField(label = "计划名称", value = planName, onValueChange = { planName = it })
                EditTextField(
                    label = "定投金额",
                    value = amount,
                    onValueChange = { amount = it },
                    keyboardType = KeyboardType.Decimal
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("day" to "日", "week" to "周", "biweek" to "双周", "month" to "月").forEach { (value, label) ->
                        FilterChip(
                            selected = intervalUnit == value,
                            onClick = { intervalUnit = value },
                            label = { Text(label) }
                        )
                    }
                }
                EditTextField(
                    label = "每几个周期执行一次",
                    value = intervalValue,
                    onValueChange = { intervalValue = it.filter(Char::isDigit) },
                    keyboardType = KeyboardType.Number
                )
                EditTextField(label = "开始日期", value = startDate, onValueChange = { startDate = it })
                EditTextField(label = "下次执行", value = nextRunDate, onValueChange = { nextRunDate = it })
                EditTextField(label = "结束日期（可空）", value = endDate, onValueChange = { endDate = it })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EditTextField(
                        label = "总次数",
                        value = totalRuns,
                        onValueChange = { totalRuns = it.filter(Char::isDigit) },
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                    EditTextField(
                        label = "执行日",
                        value = executionDay,
                        onValueChange = { executionDay = it.filter(Char::isDigit) },
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EditTextField(
                        label = "申购费率",
                        value = feeRate,
                        onValueChange = { feeRate = it },
                        keyboardType = KeyboardType.Decimal,
                        modifier = Modifier.weight(1f)
                    )
                    EditTextField(
                        label = "确认天数",
                        value = confirmDays,
                        onValueChange = { confirmDays = it.filter(Char::isDigit) },
                        keyboardType = KeyboardType.Number,
                        modifier = Modifier.weight(1f)
                    )
                }
                EditTextField(
                    label = "到账天数",
                    value = arrivalDays,
                    onValueChange = { arrivalDays = it.filter(Char::isDigit) },
                    keyboardType = KeyboardType.Number
                )
                EditTextField(label = "备注", value = memo, onValueChange = { memo = it })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = skipPendingPreceding,
                        onCheckedChange = { skipPendingPreceding = it }
                    )
                    Text("跳过前序未确认的定投")
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !isSaving && amount.toDoubleOrNull() != null && startDate.isNotBlank(),
                onClick = {
                    onSave(
                        UpdateRegularInvestRequest(
                            id = plan.id,
                            accountId = plan.accountId,
                            cashAccountId = plan.cashAccountId,
                            fundName = plan.fundName,
                            planName = planName.ifBlank { null },
                            amount = amount.toDoubleOrNull(),
                            intervalUnit = intervalUnit,
                            intervalValue = intervalValue.toIntOrNull()?.coerceAtLeast(1),
                            startDate = startDate.ifBlank { plan.startDate },
                            nextRunDate = nextRunDate.ifBlank { null },
                            endDate = endDate.ifBlank { null },
                            totalRuns = totalRuns.toIntOrNull(),
                            executionDay = executionDay.toIntOrNull(),
                            feeRate = feeRate.toDoubleOrNull(),
                            confirmDays = confirmDays.toIntOrNull(),
                            arrivalDays = arrivalDays.toIntOrNull(),
                            memo = memo.ifBlank { null },
                            skipPendingPreceding = skipPendingPreceding
                        )
                    )
                }
            ) {
                if (isSaving) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Text("保存")
                }
            }
        },
        dismissButton = {
            TextButton(enabled = !isSaving, onClick = onDismiss) {
                Text("取消")
            }
        }
    )
}

@Composable
private fun EditTextField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    modifier: Modifier = Modifier.fillMaxWidth()
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = modifier
    )
}

private fun trimNumber(value: Double): String {
    return if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()
}

private fun RegularInvestPlanDto.cashAccountDisplayName(): String {
    val cashName = cashAccountName
    return if (!cashName.isNullOrBlank()) {
        formatAccountDisplayName(cashName, cashAccountInstitutionName)
    } else {
        formatAccountDisplayName(accountName, accountInstitutionName)
    }
}

@Composable
private fun StatusChip(status: String) {
    val (text, color) = when (status) {
        "active" -> "进行中" to MaterialTheme.colorScheme.primary
        "paused" -> "已暂停" to MaterialTheme.colorScheme.tertiary
        "stopped" -> "已停止" to MaterialTheme.colorScheme.error
        else -> status to MaterialTheme.colorScheme.onSurfaceVariant
    }
    AssistChip(
        onClick = {},
        label = { Text(text, style = MaterialTheme.typography.labelSmall) },
        colors = AssistChipDefaults.assistChipColors(labelColor = color)
    )
}

@Composable
private fun InfoLine(label: String, value: String) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
private fun ActionButton(
    contentDescription: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    loading: Boolean,
    onClick: () -> Unit,
    danger: Boolean = false,
    enabled: Boolean = true
) {
    IconButton(
        onClick = onClick,
        enabled = enabled && !loading
    ) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        } else {
            Icon(
                icon,
                contentDescription = contentDescription,
                tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(20.dp)
            )
        }
    }
}

/** 频率文案，如「每月 / 每周 / 每 3 天」 */
private fun intervalText(plan: RegularInvestPlanDto): String {
    val unit = when (plan.intervalUnit) {
        "day" -> "天"
        "week" -> "周"
        "biweek" -> "双周"
        "month" -> "月"
        else -> "月"
    }
    return if (plan.intervalValue <= 1) "每$unit" else "每 ${plan.intervalValue} $unit"
}
