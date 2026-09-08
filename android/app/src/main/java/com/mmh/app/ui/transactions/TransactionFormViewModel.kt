package com.mmh.app.ui.transactions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.api.TransactionApi
import com.mmh.app.data.remote.dto.*
import com.mmh.app.data.repository.AccountRepository
import com.mmh.app.data.repository.CategoryRepository
import com.mmh.app.domain.model.Resource
import com.mmh.app.ui.util.formatAccountDisplayName
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import javax.inject.Inject

data class TransactionFormUiState(
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val error: String? = null,
    val isEdit: Boolean = false,
    val entryId: String? = null,

    // Form fields
    val type: String = "expense",
    val date: String = LocalDate.now().toString(),
    val amount: String = "",
    val accountId: String = "",
    val accountName: String = "",
    val categoryId: String? = null,
    val categoryName: String = "",
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val note: String = "",
    val tagIds: List<String> = emptyList(),

    // Investment fields
    val fundCode: String = "",
    val fundName: String = "",
    val fundProductType: String = "fund",
    val fundSubtype: String = "buy",
    val fundNav: String = "",
    val fundUnits: String = "",
    val fundFee: String = "",
    val fundConfirmDate: String = "",
    val fundArrivalDate: String = "",
    val fundArrivalAmount: String = "",
    val cashAccountId: String? = null,
    val cashAccountName: String? = null,

    // Reference data
    val categories: List<CategoryItemDto> = emptyList(),
    val accounts: List<ExternalAccountSummaryDto> = emptyList(),
    val tags: List<TagDto> = emptyList(),
)

@HiltViewModel
class TransactionFormViewModel @Inject constructor(
    private val transactionApi: TransactionApi,
    private val categoryRepository: CategoryRepository,
    private val accountRepository: AccountRepository,
    private val transactionRepository: com.mmh.app.data.repository.TransactionRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TransactionFormUiState())
    val uiState: StateFlow<TransactionFormUiState> = _uiState.asStateFlow()

    /** Initialize form for creating a new transaction */
    fun initCreate(
        type: String = "expense",
        initialFundSubtype: String = "",
        initialFundCode: String = "",
        initialFundName: String = "",
        initialAccountId: String = ""
    ) {
        viewModelScope.launch {
            _uiState.value = TransactionFormUiState(
                isLoading = false,
                isEdit = false,
                type = type,
                accountId = initialAccountId,
                fundCode = initialFundCode,
                fundName = initialFundName,
                fundSubtype = if (type == "investment") initialFundSubtype.ifBlank { "buy" } else "buy",
                categories = _uiState.value.categories,
                accounts = _uiState.value.accounts,
                tags = _uiState.value.tags
            )
            loadReferenceData(type, allowNetwork = false)
        }
    }

    /** Initialize form for editing an existing transaction */
    fun initEdit(transaction: TransactionDto) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isLoading = true, error = null, isEdit = true,
                entryId = transaction.id,
                type = transaction.type,
                date = transaction.date,
                amount = formatAmountForEdit(transaction.amount, transaction.type),
                accountId = transaction.accountId,
                accountName = formatAccountDisplayName(transaction.accountName, transaction.accountInstitutionName),
                categoryId = transaction.categoryId,
                categoryName = transaction.categoryName,
                toAccountId = transaction.toAccountId,
                toAccountName = transaction.toAccountName?.let {
                    formatAccountDisplayName(it, transaction.toAccountInstitutionName)
                },
                note = transaction.note ?: "",
                tagIds = transaction.entryTags.map { it.tagId },
                fundCode = transaction.fundCode ?: "",
                fundName = transaction.fundName ?: "",
                fundProductType = transaction.fundProductType ?: "fund",
                fundSubtype = transaction.fundSubtype ?: "buy",
                fundNav = transaction.fundNav?.let { it.toString() } ?: "",
                fundUnits = transaction.fundUnits?.let { it.toString() } ?: "",
                fundFee = transaction.fundFee?.let { it.toString() } ?: "",
                fundConfirmDate = transaction.fundConfirmDate ?: "",
                fundArrivalDate = transaction.fundArrivalDate ?: "",
                fundArrivalAmount = transaction.fundArrivalAmount?.let { it.toString() } ?: "",
            )
            loadReferenceData(transaction.type, allowNetwork = false)
        }
    }

    /** Initialize form for editing by loading the transaction from the API */
    fun initEditById(entryId: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                when (val result = transactionRepository.getTransactionById(entryId)) {
                    is com.mmh.app.domain.model.Resource.Success -> {
                        initEdit(result.data)
                    }
                    is com.mmh.app.domain.model.Resource.Error -> {
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            error = result.message
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = "加载记录失败: ${e.message}"
                )
            }
        }
    }

    private suspend fun loadReferenceData(
        type: String = _uiState.value.type,
        allowNetwork: Boolean = true
    ) {
        try {
            val categories = if (type == "expense" || type == "income") {
                val cached = categoryRepository.getCachedCategories()
                if (cached.isNotEmpty() || !allowNetwork) {
                    cached
                } else {
                    when (val result = categoryRepository.getCategories(forceRefresh = false)) {
                        is Resource.Success -> result.data
                        is Resource.Error -> _uiState.value.categories
                    }
                }
            } else {
                _uiState.value.categories
            }

            val cachedAccounts = accountRepository.getCachedAccounts()
            val accounts = if (cachedAccounts.isNotEmpty() || !allowNetwork) {
                cachedAccounts
            } else {
                when (val accountsResult = accountRepository.getAccounts(forceRefresh = false)) {
                    is Resource.Success -> accountsResult.data
                    else -> emptyList()
                }
            }
            // Most frequently used accounts first (server-tracked usageCount),
            // so the entry form's account selectors surface what the user actually uses.
            val sortedAccounts = accounts.sortedWith(
                compareByDescending<ExternalAccountSummaryDto> { it.usageCount }
                    .thenByDescending { it.lastUsedAt.orEmpty() }
            )
            val stateWithDefaults = applyReferenceDefaults(_uiState.value, sortedAccounts, type)
            val stateWithPaymentDefault = applyQuickFundTradeCashDefault(stateWithDefaults, sortedAccounts)

            _uiState.value = stateWithPaymentDefault.copy(
                isLoading = false,
                categories = categories,
                accounts = sortedAccounts,
            )
        } catch (e: Exception) {
            _uiState.value = _uiState.value.copy(
                isLoading = false,
                error = "加载数据失败: ${e.message}"
            )
        }
    }

    private fun applyReferenceDefaults(
        state: TransactionFormUiState,
        accounts: List<ExternalAccountSummaryDto>,
        type: String
    ): TransactionFormUiState {
        if (accounts.isEmpty()) return state
        return when (type) {
            "investment" -> {
                val investmentState = if (state.isEdit) {
                    state.resolveInvestmentEditAccounts(accounts)
                } else {
                    state
                }
                val currentAccount = accounts.firstOrNull { it.id == investmentState.accountId }
                val investAccount = accounts.firstOrNull { it.kind == "investment" }
                val cashAccount = accounts.firstOrNull { it.kind != "investment" }
                val selectedInvestAccount = currentAccount?.takeIf { it.kind == "investment" } ?: investAccount
                val selectedCashAccount = accounts.firstOrNull { it.id == investmentState.cashAccountId && it.kind != "investment" }
                    ?: cashAccount.takeUnless { investmentState.isEdit || investmentState.fundSubtype == "dividend_reinvest" }
                investmentState.copy(
                    accountId = selectedInvestAccount?.id.orEmpty(),
                    accountName = selectedInvestAccount?.formDisplayName().orEmpty(),
                    cashAccountId = selectedCashAccount?.id,
                    cashAccountName = selectedCashAccount?.formDisplayName()
                )
            }
            "transfer" -> {
                val currentAccount = accounts.firstOrNull { it.id == state.accountId && it.kind != "investment" }
                val fromAccount = currentAccount ?: accounts.firstOrNull { it.kind != "investment" } ?: accounts.first()
                val currentToAccount = accounts.firstOrNull {
                    it.id == state.toAccountId && it.id != fromAccount.id && it.kind != "investment"
                }
                val toAccount = currentToAccount ?: accounts.firstOrNull { it.id != fromAccount.id && it.kind != "investment" }
                state.copy(
                    accountId = fromAccount.id,
                    accountName = fromAccount.formDisplayName(),
                    toAccountId = toAccount?.id,
                    toAccountName = toAccount?.formDisplayName()
                )
            }
            else -> {
                val currentAccount = accounts.firstOrNull { it.id == state.accountId && it.kind != "investment" }
                val account = currentAccount ?: accounts.firstOrNull { it.kind != "investment" } ?: accounts.first()
                state.copy(
                    accountId = account.id,
                    accountName = account.formDisplayName()
                )
            }
        }
    }

    private fun ExternalAccountSummaryDto.formDisplayName(): String =
        formatAccountDisplayName(name, institutionName)

    private fun TransactionFormUiState.resolveInvestmentEditAccounts(
        accounts: List<ExternalAccountSummaryDto>
    ): TransactionFormUiState {
        val sourceAccount = accounts.firstOrNull { it.id == accountId }
        val targetAccount = accounts.firstOrNull { it.id == toAccountId }
        val existingCashAccount = accounts.firstOrNull { it.id == cashAccountId && it.kind != "investment" }
        val isCashReceivingSubtype = fundSubtype == "redeem" || fundSubtype == "switch_out" || fundSubtype == "dividend_cash"

        val investmentAccount = when {
            sourceAccount?.kind == "investment" -> sourceAccount
            targetAccount?.kind == "investment" -> targetAccount
            else -> accounts.firstOrNull { it.kind == "investment" }
        }
        val cashAccount = when {
            fundSubtype == "dividend_reinvest" -> null
            existingCashAccount != null -> existingCashAccount
            isCashReceivingSubtype && targetAccount?.kind != null && targetAccount.kind != "investment" -> targetAccount
            !isCashReceivingSubtype && sourceAccount?.kind != null && sourceAccount.kind != "investment" -> sourceAccount
            sourceAccount?.kind != null && sourceAccount.kind != "investment" -> sourceAccount
            targetAccount?.kind != null && targetAccount.kind != "investment" -> targetAccount
            else -> null
        }

        return copy(
            accountId = investmentAccount?.id.orEmpty(),
            accountName = investmentAccount?.formDisplayName().orEmpty(),
            cashAccountId = cashAccount?.id,
            cashAccountName = cashAccount?.formDisplayName()
        )
    }

    private suspend fun applyQuickFundTradeCashDefault(
        state: TransactionFormUiState,
        accounts: List<ExternalAccountSummaryDto>
    ): TransactionFormUiState {
        val isQuickFundTrade = state.type == "investment" &&
            (state.fundSubtype == "buy" || state.fundSubtype == "redeem") &&
            state.fundCode.isNotBlank()
        if (state.isEdit || !isQuickFundTrade) {
            return state
        }
        val eligibleAccounts = accounts.filter { it.isFundPaymentAccount() }
        if (eligibleAccounts.isEmpty()) return state.copy(cashAccountId = null, cashAccountName = null)

        val entries = transactionRepository.getCachedFundTransactions(state.accountId, state.fundCode)
        val preferredSubtypes = if (state.fundSubtype == "redeem") {
            setOf("redeem")
        } else {
            setOf("buy", "regular_invest", "")
        }
        val recentCashAccountId = entries
            .filter { preferredSubtypes.contains(it.fundSubtype.orEmpty()) }
            .mapNotNull { entry ->
                when {
                    entry.accountId != state.accountId -> entry.accountId
                    !entry.toAccountId.isNullOrBlank() && entry.toAccountId != state.accountId -> entry.toAccountId
                    else -> null
                }
            }
            .firstOrNull { id -> eligibleAccounts.any { it.id == id } }
        val selected = recentCashAccountId
            ?.let { id -> eligibleAccounts.firstOrNull { it.id == id } }
            ?: state.cashAccountId?.let { id -> eligibleAccounts.firstOrNull { it.id == id } }
            ?: eligibleAccounts.first()
        return state.copy(
            cashAccountId = selected.id,
            cashAccountName = selected.formDisplayName()
        )
    }

    private fun ExternalAccountSummaryDto.isFundPaymentAccount(): Boolean {
        return kind != "investment" && kind != "cash" && kind != "bank_credit" && kind != "loan" && kind != "settlement"
    }

    fun updateType(type: String) {
        val next = _uiState.value.copy(type = type)
        _uiState.value = applyReferenceDefaults(next, next.accounts, type)
    }

    fun updateDate(date: String) {
        _uiState.value = _uiState.value.copy(date = date)
    }

    fun updateAmount(amount: String) {
        _uiState.value = _uiState.value.copy(amount = amount.positiveDecimalText())
    }

    fun updateAccountId(accountId: String, accountName: String) {
        _uiState.value = _uiState.value.copy(accountId = accountId, accountName = accountName)
    }

    fun updateCategoryId(categoryId: String?, categoryName: String) {
        _uiState.value = _uiState.value.copy(categoryId = categoryId, categoryName = categoryName)
    }

    fun updateToAccount(toAccountId: String?, toAccountName: String?) {
        _uiState.value = _uiState.value.copy(toAccountId = toAccountId, toAccountName = toAccountName)
    }

    fun updateNote(note: String) {
        _uiState.value = _uiState.value.copy(note = note)
    }

    fun updateTagIds(tagIds: List<String>) {
        _uiState.value = _uiState.value.copy(tagIds = tagIds)
    }

    fun updateFundCode(code: String) {
        _uiState.value = _uiState.value.copy(fundCode = code)
    }

    fun updateFundSubtype(subtype: String) {
        val current = _uiState.value
        _uiState.value = if (subtype == "redeem" || subtype == "dividend_cash" || subtype == "switch_out") {
            current.copy(fundSubtype = subtype)
        } else {
            current.copy(
                fundSubtype = subtype,
                fundArrivalDate = "",
                fundArrivalAmount = ""
            )
        }
    }

    fun updateFundNav(nav: String) {
        _uiState.value = _uiState.value.copy(fundNav = nav)
    }

    fun updateFundUnits(units: String) {
        _uiState.value = _uiState.value.copy(fundUnits = units)
    }

    fun updateFundFee(fee: String) {
        _uiState.value = _uiState.value.copy(fundFee = fee.positiveDecimalText())
    }

    fun updateFundConfirmDate(date: String) {
        _uiState.value = _uiState.value.copy(fundConfirmDate = date)
    }

    fun updateFundArrivalDate(date: String) {
        _uiState.value = _uiState.value.copy(fundArrivalDate = date)
    }

    fun updateFundArrivalAmount(amount: String) {
        _uiState.value = _uiState.value.copy(fundArrivalAmount = amount.positiveDecimalText())
    }

    fun updateCashAccountId(id: String?, name: String?) {
        _uiState.value = _uiState.value.copy(cashAccountId = id, cashAccountName = name)
    }

    fun updateFundName(name: String) {
        _uiState.value = _uiState.value.copy(fundName = name)
    }

    /** Save/Create the transaction */
    fun save(onSuccess: () -> Unit) {
        val state = _uiState.value
        val amountValue = state.amount.toDoubleOrNull() ?: return
        if (amountValue <= 0) {
            _uiState.value = state.copy(error = "请输入金额")
            return
        }
        if (state.accountId.isEmpty()) {
            _uiState.value = state.copy(error = "请选择账户")
            return
        }
        if (state.type == "transfer" && state.toAccountId.isNullOrEmpty()) {
            _uiState.value = state.copy(error = "请选择转入账户")
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, error = null)

            try {
                val result = if (state.isEdit && state.entryId != null) {
                    updateTransaction(state)
                } else {
                    createTransaction(state)
                }

                when (result) {
                    is Resource.Success -> {
                        _uiState.value = _uiState.value.copy(isSaving = false)
                        onSuccess()
                    }
                    is Resource.Error -> {
                        _uiState.value = _uiState.value.copy(isSaving = false, error = result.message)
                    }
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(isSaving = false, error = e.message ?: "保存失败")
            }
        }
    }

    private suspend fun createTransaction(state: TransactionFormUiState): Resource<TransactionDto> {
        val amount = state.amount.toDoubleOrNull() ?: return Resource.Error("金额不正确")
        return try {
            val request = when (state.type) {
                "transfer" -> CreateTransactionRequest(
                    date = state.date, amount = amount, type = "transfer",
                    accountId = state.accountId,
                    toAccountId = state.toAccountId,
                    toAccountName = state.toAccountName,
                    note = state.note.ifBlank { null },
                    tagIds = state.tagIds.ifEmpty { null },
                )
                "investment" -> CreateTransactionRequest(
                    date = state.date, amount = amount, type = "investment",
                    accountId = state.accountId,
                    note = state.note.ifBlank { null },
                    tagIds = state.tagIds.ifEmpty { null },
                    fundCode = state.fundCode.ifBlank { null },
                    fundName = state.fundName.ifBlank { null },
                    fundProductType = state.fundProductType,
                    fundSubtype = state.fundSubtype,
                    fundNav = state.fundNav.toDoubleOrNull(),
                    fundUnits = state.fundUnits.toDoubleOrNull(),
                    fundFee = state.fundFee.toDoubleOrNull(),
                    fundConfirmDate = state.fundConfirmDate.ifBlank { null },
                    fundArrivalDate = state.fundArrivalDate.takeIf { state.needsArrivalFields() }?.ifBlank { null },
                    fundArrivalAmount = state.fundArrivalAmount.takeIf { state.needsArrivalFields() }?.toDoubleOrNull(),
                    cashAccountId = state.cashAccountId,
                )
                else -> CreateTransactionRequest(
                    date = state.date, amount = amount, type = state.type,
                    accountId = state.accountId,
                    categoryId = state.categoryId,
                    categoryName = state.categoryName.ifBlank { null },
                    note = state.note.ifBlank { null },
                    tagIds = state.tagIds.ifEmpty { null },
                )
            }
            val response = transactionApi.createTransaction(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("创建失败"))
            } else {
                Resource.Error(response.body()?.error ?: "创建失败")
            }
        } catch (e: Exception) {
            Resource.Error(e.message ?: "网络错误")
        }
    }

    private suspend fun updateTransaction(state: TransactionFormUiState): Resource<TransactionDto> {
        val amount = state.amount.toDoubleOrNull() ?: return Resource.Error("金额不正确")
        return try {
            val request = UpdateTransactionRequest(
                id = state.entryId ?: return Resource.Error("缺少记录ID"),
                date = state.date,
                amount = amount,
                type = state.type,
                accountId = state.accountId,
                categoryId = state.categoryId,
                categoryName = state.categoryName.ifBlank { null },
                toAccountId = state.toAccountId,
                toAccountName = state.toAccountName,
                note = state.note.ifBlank { null },
                tagIds = state.tagIds.ifEmpty { null },
                fundCode = state.fundCode.ifBlank { null },
                fundName = state.fundName.ifBlank { null },
                fundProductType = state.fundProductType,
                fundSubtype = state.fundSubtype,
                fundNav = state.fundNav.toDoubleOrNull(),
                fundUnits = state.fundUnits.toDoubleOrNull(),
                fundFee = state.fundFee.toDoubleOrNull(),
                fundConfirmDate = state.fundConfirmDate.ifBlank { null },
                fundArrivalDate = state.fundArrivalDate.takeIf { state.needsArrivalFields() }?.ifBlank { null },
                fundArrivalAmount = state.fundArrivalAmount.takeIf { state.needsArrivalFields() }?.toDoubleOrNull(),
                cashAccountId = state.cashAccountId,
            )
            val response = transactionApi.updateTransaction(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("更新失败"))
            } else {
                Resource.Error(response.body()?.error ?: "更新失败")
            }
        } catch (e: Exception) {
            Resource.Error(e.message ?: "网络错误")
        }
    }

    /** Delete the transaction (only in edit mode) */
    fun delete(onSuccess: () -> Unit) {
        val entryId = _uiState.value.entryId ?: return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, error = null)
            try {
                val response = transactionApi.deleteTransaction(entryId)
                if (response.isSuccessful && response.body()?.ok == true) {
                    onSuccess()
                } else {
                    _uiState.value = _uiState.value.copy(
                        isSaving = false,
                        error = response.body()?.error ?: "删除失败"
                    )
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    error = e.message ?: "删除失败"
                )
            }
        }
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    companion object {
        private fun formatAmountForEdit(amount: Double, type: String): String {
            return if (type == "expense" || type == "transfer" || type == "investment")
                String.format("%.2f", kotlin.math.abs(amount))
            else
                String.format("%.2f", amount)
        }
    }
}

private fun TransactionFormUiState.needsArrivalFields(): Boolean {
    return fundSubtype == "redeem" || fundSubtype == "dividend_cash" || fundSubtype == "switch_out"
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
