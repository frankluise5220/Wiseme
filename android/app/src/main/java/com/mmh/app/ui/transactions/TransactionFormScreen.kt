package com.mmh.app.ui.transactions

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountBalance
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Notes
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mmh.app.data.remote.dto.ExternalAccountSummaryDto
import com.mmh.app.data.remote.dto.TransactionDto
import com.mmh.app.ui.util.formatAccountDisplayName

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionFormScreen(
    onBack: () -> Unit,
    onSaved: () -> Unit,
    editTransaction: TransactionDto? = null,
    entryId: String? = null,
    initialType: String = "expense",
    initialFundSubtype: String = "",
    initialFundCode: String = "",
    initialFundName: String = "",
    initialAccountId: String = "",
    viewModel: TransactionFormViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val isInvestment = uiState.type == "investment"
    val isQuickFundBuy = isInvestment && !uiState.isEdit && uiState.fundSubtype == "buy" && uiState.fundCode.isNotBlank()
    val isQuickFundSell = isInvestment && !uiState.isEdit && uiState.fundSubtype == "redeem" && uiState.fundCode.isNotBlank()

    LaunchedEffect(editTransaction, entryId, initialType, initialFundSubtype, initialFundCode, initialFundName, initialAccountId) {
        if (editTransaction != null) {
            viewModel.initEdit(editTransaction)
        } else if (!entryId.isNullOrEmpty()) {
            viewModel.initEditById(entryId)
        } else {
            viewModel.initCreate(
                type = initialType,
                initialFundSubtype = initialFundSubtype,
                initialFundCode = initialFundCode,
                initialFundName = initialFundName,
                initialAccountId = initialAccountId
            )
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(transactionFormTitle(uiState)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (uiState.isEdit) {
                        IconButton(onClick = { viewModel.delete { onSaved() } }) {
                            Icon(Icons.Default.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)
            )
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (uiState.isLoading) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    if (uiState.error != null) {
                        ErrorCard(message = uiState.error.orEmpty(), onClose = viewModel::clearError)
                    }

                    if (!isInvestment) {
                        TypeSelector(
                            selectedType = uiState.type,
                            onTypeSelected = { viewModel.updateType(it) },
                            enabled = !uiState.isEdit
                        )
                    }

                    if (isQuickFundBuy) {
                        QuickFundBuyFields(uiState, viewModel)
                    } else if (isQuickFundSell) {
                        QuickFundSellFields(uiState, viewModel)
                    } else {
                        OutlinedTextField(
                            value = uiState.date,
                            onValueChange = { viewModel.updateDate(it) },
                            label = { Text("日期") },
                            placeholder = { Text("YYYY-MM-DD") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            leadingIcon = { Icon(Icons.Default.DateRange, contentDescription = null) }
                        )

                        OutlinedTextField(
                            value = uiState.amount,
                            onValueChange = { viewModel.updateAmount(it.positiveDecimalText()) },
                            label = { Text(if (isInvestment) investmentAmountLabel(uiState.fundSubtype) else "金额") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                            prefix = { Text("¥") }
                        )

                        when (uiState.type) {
                            "expense", "income" -> ExpenseIncomeFields(uiState, viewModel)
                            "transfer" -> TransferFields(uiState, viewModel)
                            "investment" -> InvestmentFields(uiState, viewModel)
                        }

                        OutlinedTextField(
                            value = uiState.note,
                            onValueChange = { viewModel.updateNote(it) },
                            label = { Text("备注") },
                            modifier = Modifier.fillMaxWidth(),
                            maxLines = 3,
                            leadingIcon = { Icon(Icons.Default.Notes, contentDescription = null) }
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    Button(
                        onClick = { viewModel.save { onSaved() } },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp),
                        enabled = !uiState.isSaving
                    ) {
                        if (uiState.isSaving) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(if (uiState.isEdit) "保存修改" else if (isQuickFundBuy) "确认买入" else if (isQuickFundSell) "确认卖出" else "添加记录")
                    }

                    Spacer(modifier = Modifier.height(32.dp))
                }
            }
        }
    }
}

@Composable
private fun ErrorCard(message: String, onClose: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.Error, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
            Spacer(Modifier.width(8.dp))
            Text(
                text = message,
                color = MaterialTheme.colorScheme.onErrorContainer,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = onClose) {
                Icon(Icons.Default.Close, contentDescription = "关闭", tint = MaterialTheme.colorScheme.onErrorContainer)
            }
        }
    }
}

private fun transactionFormTitle(uiState: TransactionFormUiState): String {
    if (uiState.isEdit && uiState.type == "investment") return "编辑基金交易"
    if (uiState.isEdit) return "编辑交易"
    return when (uiState.type) {
        "investment" -> if (uiState.fundSubtype == "redeem") "卖出基金" else "买入基金"
        "transfer" -> "转账"
        else -> "记一笔"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TypeSelector(
    selectedType: String,
    onTypeSelected: (String) -> Unit,
    enabled: Boolean
) {
    val types = listOf(
        "expense" to "支出",
        "income" to "收入",
        "transfer" to "转账",
        "investment" to "投资"
    )

    Text(text = "类型", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        types.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = selectedType == value,
                onClick = { onTypeSelected(value) },
                enabled = enabled,
                shape = SegmentedButtonDefaults.itemShape(index = index, count = types.size)
            ) {
                Text(label, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExpenseIncomeFields(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    var accountExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = accountExpanded, onExpandedChange = { accountExpanded = it }) {
        OutlinedTextField(
            value = uiState.accountName,
            onValueChange = {},
            readOnly = true,
            label = { Text("账户") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = accountExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.AccountBalance, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = accountExpanded, onDismissRequest = { accountExpanded = false }) {
            uiState.accounts.forEach { account ->
                DropdownMenuItem(
                    text = { Text(account.displayName()) },
                    onClick = {
                        viewModel.updateAccountId(account.id, account.displayName())
                        accountExpanded = false
                    }
                )
            }
        }
    }

    var categoryExpanded by remember { mutableStateOf(false) }
    val catOptions = uiState.categories.filter { it.type == uiState.type || it.type == "expense" }
    val currentCat = catOptions.find { it.id == uiState.categoryId }
    ExposedDropdownMenuBox(expanded = categoryExpanded, onExpandedChange = { categoryExpanded = it }) {
        OutlinedTextField(
            value = currentCat?.name ?: uiState.categoryName,
            onValueChange = {},
            readOnly = true,
            label = { Text("分类") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = categoryExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.Category, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = categoryExpanded, onDismissRequest = { categoryExpanded = false }) {
            catOptions.forEach { cat ->
                DropdownMenuItem(
                    text = { Text(cat.name) },
                    onClick = {
                        viewModel.updateCategoryId(cat.id, cat.name)
                        categoryExpanded = false
                    }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TransferFields(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    var fromExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = fromExpanded, onExpandedChange = { fromExpanded = it }) {
        OutlinedTextField(
            value = uiState.accountName,
            onValueChange = {},
            readOnly = true,
            label = { Text("转出账户") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = fromExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.ArrowForward, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = fromExpanded, onDismissRequest = { fromExpanded = false }) {
            uiState.accounts.forEach { account ->
                DropdownMenuItem(
                    text = { Text(account.displayName()) },
                    onClick = {
                        viewModel.updateAccountId(account.id, account.displayName())
                        fromExpanded = false
                    }
                )
            }
        }
    }

    var toExpanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = toExpanded, onExpandedChange = { toExpanded = it }) {
        OutlinedTextField(
            value = uiState.toAccountName ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text("转入账户") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = toExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.ArrowBack, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = toExpanded, onDismissRequest = { toExpanded = false }) {
            uiState.accounts
                .filter { it.id != uiState.accountId }
                .forEach { account ->
                    DropdownMenuItem(
                        text = { Text(account.displayName()) },
                        onClick = {
                            viewModel.updateToAccount(account.id, account.displayName())
                            toExpanded = false
                        }
                    )
                }
        }
    }
}

@Composable
private fun QuickFundBuyFields(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = uiState.fundName.ifBlank { "基金买入" },
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = uiState.fundCode,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            OutlinedTextField(
                value = uiState.date,
                onValueChange = { viewModel.updateDate(it) },
                label = { Text("日期") },
                placeholder = { Text("YYYY-MM-DD") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                leadingIcon = { Icon(Icons.Default.DateRange, contentDescription = null) }
            )

            CashAccountField(uiState, viewModel, label = "资金账户", fundPaymentOnly = true)

            OutlinedTextField(
                value = uiState.amount,
                onValueChange = { viewModel.updateAmount(it.positiveDecimalText()) },
                label = { Text("金额") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                prefix = { Text("¥") }
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = uiState.fundFee,
                    onValueChange = { viewModel.updateFundFee(it.positiveDecimalText()) },
                    label = { Text("手续费") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    prefix = { Text("¥") }
                )
                OutlinedTextField(
                    value = uiState.fundUnits,
                    onValueChange = { viewModel.updateFundUnits(it.positiveDecimalText()) },
                    label = { Text("份额") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    placeholder = { Text("未确认可空") }
                )
            }

            OutlinedTextField(
                value = uiState.note,
                onValueChange = { viewModel.updateNote(it) },
                label = { Text("备注") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 3,
                leadingIcon = { Icon(Icons.Default.Notes, contentDescription = null) }
            )
        }
    }
}

@Composable
private fun QuickFundSellFields(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = uiState.fundName.ifBlank { "基金卖出" },
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = uiState.fundCode,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            OutlinedTextField(
                value = uiState.date,
                onValueChange = { viewModel.updateDate(it) },
                label = { Text("日期") },
                placeholder = { Text("YYYY-MM-DD") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                leadingIcon = { Icon(Icons.Default.DateRange, contentDescription = null) }
            )

            CashAccountField(uiState, viewModel, label = "到账资金账户", fundPaymentOnly = true)

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = uiState.amount,
                    onValueChange = { viewModel.updateAmount(it.positiveDecimalText()) },
                    label = { Text("赎回金额") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    prefix = { Text("¥") }
                )
                OutlinedTextField(
                    value = uiState.fundUnits,
                    onValueChange = { viewModel.updateFundUnits(it.positiveDecimalText()) },
                    label = { Text("赎回份额") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                )
            }

            OutlinedTextField(
                value = uiState.fundFee,
                onValueChange = { viewModel.updateFundFee(it.positiveDecimalText()) },
                label = { Text("手续费") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                prefix = { Text("¥") }
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = uiState.fundArrivalAmount,
                    onValueChange = { viewModel.updateFundArrivalAmount(it.positiveDecimalText()) },
                    label = { Text("到账金额") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    prefix = { Text("¥") }
                )
                OutlinedTextField(
                    value = uiState.fundArrivalDate,
                    onValueChange = { viewModel.updateFundArrivalDate(it) },
                    label = { Text("到账日期") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    placeholder = { Text("YYYY-MM-DD") }
                )
            }

            OutlinedTextField(
                value = uiState.note,
                onValueChange = { viewModel.updateNote(it) },
                label = { Text("备注") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 3,
                leadingIcon = { Icon(Icons.Default.Notes, contentDescription = null) }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InvestmentFields(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    var investExpanded by remember { mutableStateOf(false) }
    val investAccounts = uiState.accounts.filter { it.kind == "investment" }
    ExposedDropdownMenuBox(expanded = investExpanded, onExpandedChange = { investExpanded = it }) {
        OutlinedTextField(
            value = if (uiState.accountId.isNotEmpty()) uiState.accountName else "",
            onValueChange = {},
            readOnly = true,
            label = { Text("投资账户") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = investExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.ShowChart, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = investExpanded, onDismissRequest = { investExpanded = false }) {
            investAccounts.forEach { account ->
                DropdownMenuItem(
                    text = { Text(account.displayName()) },
                    onClick = {
                        viewModel.updateAccountId(account.id, account.displayName())
                        investExpanded = false
                    }
                )
            }
        }
    }

    FundSubtypeSelector(uiState, viewModel)

    OutlinedTextField(
        value = uiState.fundCode,
        onValueChange = { viewModel.updateFundCode(it) },
        label = { Text("基金代码") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        leadingIcon = { Icon(Icons.Default.Tag, contentDescription = null) }
    )

    OutlinedTextField(
        value = uiState.fundName,
        onValueChange = { viewModel.updateFundName(it) },
        label = { Text("基金名称") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true
    )

    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = uiState.fundNav,
            onValueChange = { viewModel.updateFundNav(it.positiveDecimalText()) },
            label = { Text("净值") },
            modifier = Modifier.weight(1f),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
        )
        OutlinedTextField(
            value = uiState.fundUnits,
            onValueChange = { viewModel.updateFundUnits(it.positiveDecimalText()) },
            label = { Text("份额") },
            modifier = Modifier.weight(1f),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
        )
    }

    if (uiState.fundSubtype != "dividend_reinvest") {
        CashAccountField(uiState, viewModel)
    }

    OutlinedTextField(
        value = uiState.fundFee,
        onValueChange = { viewModel.updateFundFee(it.positiveDecimalText()) },
        label = { Text("手续费") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        prefix = { Text("¥") }
    )

    OutlinedTextField(
        value = uiState.fundConfirmDate,
        onValueChange = { viewModel.updateFundConfirmDate(it) },
        label = { Text("确认日期") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        placeholder = { Text("YYYY-MM-DD") }
    )

    if (needsArrivalFields(uiState.fundSubtype)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = uiState.fundArrivalAmount,
                onValueChange = { viewModel.updateFundArrivalAmount(it.positiveDecimalText()) },
                label = { Text("到账金额") },
                modifier = Modifier.weight(1f),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                prefix = { Text("¥") }
            )
            OutlinedTextField(
                value = uiState.fundArrivalDate,
                onValueChange = { viewModel.updateFundArrivalDate(it) },
                label = { Text("到账日期") },
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("YYYY-MM-DD") }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FundSubtypeSelector(uiState: TransactionFormUiState, viewModel: TransactionFormViewModel) {
    val baseSubtypes = listOf(
        "buy" to "买入",
        "redeem" to "赎回",
        "dividend_reinvest" to "分红再投",
        "dividend_cash" to "现金分红"
    )
    val subtypes = if (uiState.isEdit && uiState.fundSubtype == "switch_in") {
        baseSubtypes + ("switch_in" to "转入")
    } else if (uiState.isEdit && uiState.fundSubtype == "switch_out") {
        baseSubtypes + ("switch_out" to "转出")
    } else {
        baseSubtypes
    }
    var subtypeExpanded by remember { mutableStateOf(false) }
    val currentSubtype = subtypes.find { it.first == uiState.fundSubtype }

    if (uiState.isEdit) {
        OutlinedTextField(
            value = currentSubtype?.second ?: "买入",
            onValueChange = {},
            readOnly = true,
            label = { Text("交易类型") },
            modifier = Modifier.fillMaxWidth()
        )
        return
    }

    ExposedDropdownMenuBox(expanded = subtypeExpanded, onExpandedChange = { subtypeExpanded = it }) {
        OutlinedTextField(
            value = currentSubtype?.second ?: "买入",
            onValueChange = {},
            readOnly = true,
            label = { Text("基金操作") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = subtypeExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor()
        )
        ExposedDropdownMenu(expanded = subtypeExpanded, onDismissRequest = { subtypeExpanded = false }) {
            subtypes.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        viewModel.updateFundSubtype(value)
                        subtypeExpanded = false
                    }
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CashAccountField(
    uiState: TransactionFormUiState,
    viewModel: TransactionFormViewModel,
    label: String = "资金账户（可选）",
    fundPaymentOnly: Boolean = false
) {
    var cashExpanded by remember { mutableStateOf(false) }
    val cashAccounts = uiState.accounts.filter {
        if (fundPaymentOnly) {
            it.kind != "investment" && it.kind != "cash" && it.kind != "bank_credit" && it.kind != "loan" && it.kind != "settlement"
        } else {
            it.kind != "investment"
        }
    }
    ExposedDropdownMenuBox(expanded = cashExpanded, onExpandedChange = { cashExpanded = it }) {
        OutlinedTextField(
            value = uiState.cashAccountName ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = cashExpanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(),
            leadingIcon = { Icon(Icons.Default.AccountBalanceWallet, contentDescription = null) }
        )
        ExposedDropdownMenu(expanded = cashExpanded, onDismissRequest = { cashExpanded = false }) {
            cashAccounts.forEach { account ->
                DropdownMenuItem(
                    text = { Text(account.displayName()) },
                    onClick = {
                        viewModel.updateCashAccountId(account.id, account.displayName())
                        cashExpanded = false
                    }
                )
            }
        }
    }
}

private fun investmentAmountLabel(subtype: String): String = when (subtype) {
    "redeem" -> "赎回金额"
    "dividend_cash" -> "分红金额"
    "switch_out" -> "转出金额"
    "switch_in" -> "转入金额"
    else -> "买入金额"
}

private fun needsArrivalFields(subtype: String): Boolean {
    return subtype == "redeem" || subtype == "dividend_cash" || subtype == "switch_out"
}

private fun String.positiveDecimalText(): String {
    val filtered = filter { it.isDigit() || it == '.' }
    val firstDot = filtered.indexOf('.')
    return if (firstDot < 0) {
        filtered
    } else {
        filtered.take(firstDot + 1) + filtered.drop(firstDot + 1).replace(".", "")
    }
}

private fun ExternalAccountSummaryDto.displayName(): String = formatAccountDisplayName(name, institutionName)
