package com.mmh.app.ui.transactions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.TransactionItemDto
import com.mmh.app.data.repository.TransactionRepository
import com.mmh.app.domain.model.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class TransactionRecentUiState(
    val isLoading: Boolean = false,
    val transactions: List<TransactionItemDto> = emptyList(),
    val totalCount: Int = 0,
    val error: String? = null
)

@HiltViewModel
class TransactionRecentViewModel @Inject constructor(
    private val transactionRepository: TransactionRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TransactionRecentUiState())
    val uiState: StateFlow<TransactionRecentUiState> = _uiState.asStateFlow()
    private var loadJob: Job? = null

    fun loadTransactions() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            val previous = _uiState.value
            _uiState.value = previous.copy(
                isLoading = true,
                error = null
            )

            when (val result = transactionRepository.getExternalTransactions(limit = 200)) {
                is Resource.Success -> {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        transactions = result.data,
                        totalCount = result.data.size
                    )
                }
                is Resource.Error -> {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = result.message
                    )
                }
            }
        }
    }

    fun refresh() {
        loadTransactions()
    }

    fun deleteTransaction(tx: TransactionItemDto, onSuccess: (() -> Unit)? = null) {
        val recordId = tx.transactionId.ifEmpty { tx.id }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(error = null)
            when (val result = transactionRepository.deleteTransaction(recordId)) {
                is Resource.Success -> {
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
