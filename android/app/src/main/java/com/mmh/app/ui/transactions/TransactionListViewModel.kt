package com.mmh.app.ui.transactions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.TransactionDto
import com.mmh.app.data.remote.dto.TransactionItemDto
import com.mmh.app.data.repository.TransactionRepository
import com.mmh.app.domain.model.Resource
import com.mmh.app.ui.util.formatAccountDisplayName
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TransactionListUiState(
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val accountId: String? = null,
    val accountName: String? = null,
    val transactions: List<TransactionItemDto> = emptyList(),
    val totalCount: Int = 0,
    val error: String? = null
)

@HiltViewModel
class TransactionListViewModel @Inject constructor(
    private val transactionRepository: TransactionRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TransactionListUiState())
    val uiState: StateFlow<TransactionListUiState> = _uiState.asStateFlow()
    private var loadJob: Job? = null

    fun loadTransactions(accountId: String? = null, accountName: String? = null) {
        val previous = _uiState.value
        val switchingAccount = previous.accountId != accountId || previous.accountName != accountName

        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.value = previous.copy(
                isLoading = true,
                error = null,
                accountId = accountId,
                accountName = accountName,
                transactions = if (switchingAccount) emptyList() else previous.transactions,
                totalCount = if (switchingAccount) 0 else previous.totalCount
            )

            if (accountId.isNullOrBlank()) {
                when (val result = transactionRepository.getExternalTransactions(
                    accountName = accountName,
                    limit = 200
                )) {
                    is Resource.Success -> {
                        if (_uiState.value.accountId != accountId || _uiState.value.accountName != accountName) return@launch
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            transactions = result.data,
                            totalCount = result.data.size
                        )
                    }
                    is Resource.Error -> {
                        if (_uiState.value.accountId != accountId || _uiState.value.accountName != accountName) return@launch
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            error = result.message
                        )
                    }
                }
                return@launch
            }

            when (val result = transactionRepository.getTransactionDetail(
                accountId = accountId,
                page = 1,
                pageSize = 200
            )) {
                is Resource.Success -> {
                    if (_uiState.value.accountId != accountId || _uiState.value.accountName != accountName) return@launch
                    val items = result.data.entries.map { it.toListItem() }
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        transactions = items,
                        totalCount = result.data.totalCount
                    )
                }
                is Resource.Error -> {
                    if (_uiState.value.accountId != accountId || _uiState.value.accountName != accountName) return@launch
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = result.message
                    )
                }
            }
        }
    }

    fun refresh() {
        loadTransactions(_uiState.value.accountId, _uiState.value.accountName)
    }

    private fun TransactionDto.toListItem(): TransactionItemDto {
        val displayAccountName = when {
            accountName.isNotBlank() && accountId == _uiState.value.accountId -> {
                formatAccountDisplayName(accountName, accountInstitutionName)
            }
            !toAccountName.isNullOrBlank() && toAccountId == _uiState.value.accountId -> {
                formatAccountDisplayName(toAccountName, toAccountInstitutionName)
            }
            accountName.isNotBlank() -> formatAccountDisplayName(accountName, accountInstitutionName)
            else -> formatAccountDisplayName(toAccountName.orEmpty(), toAccountInstitutionName)
        }
        val counterpartyName = when {
            !toAccountName.isNullOrBlank() && toAccountId != _uiState.value.accountId -> {
                formatAccountDisplayName(toAccountName, toAccountInstitutionName)
            }
            accountName.isNotBlank() && accountId != _uiState.value.accountId -> {
                formatAccountDisplayName(accountName, accountInstitutionName)
            }
            else -> null
        }
        return TransactionItemDto(
            id = id,
            transactionId = id,
            date = date,
            type = type,
            amount = amount,
            accountId = accountId,
            accountName = displayAccountName,
            accountInstitutionName = accountInstitutionName,
            toAccountId = toAccountId,
            toAccountName = toAccountName,
            toAccountInstitutionName = toAccountInstitutionName,
            categoryName = categoryName,
            note = note,
            counterparty = counterpartyName,
            sourceText = source
        )
    }

    /** Delete a transaction by its TransactionItemDto (calls API by transactionId) */
    fun deleteTransaction(tx: TransactionItemDto, onSuccess: (() -> Unit)? = null) {
        val recordId = tx.transactionId.ifEmpty { tx.id }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(error = null)
            when (val result = transactionRepository.deleteTransaction(recordId)) {
                is Resource.Success -> {
                    // Remove from local list and refresh
                    val updated = _uiState.value.transactions.filter { it.id != tx.id }
                    _uiState.value = _uiState.value.copy(
                        transactions = updated,
                        totalCount = updated.size
                    )
                    onSuccess?.invoke()
                }
                is Resource.Error -> {
                    _uiState.value = _uiState.value.copy(error = result.message)
                }
            }
        }
    }
}
