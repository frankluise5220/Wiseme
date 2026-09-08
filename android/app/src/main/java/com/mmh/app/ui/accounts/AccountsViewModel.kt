package com.mmh.app.ui.accounts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.AccountListRowDto
import com.mmh.app.data.repository.OverviewRepository
import com.mmh.app.domain.model.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AccountGroup(
    val kind: String,
    val kindLabel: String,
    val accounts: List<AccountListRowDto>,
    val groupTotal: Double
)

data class AccountsUiState(
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val groups: List<AccountGroup> = emptyList(),
    val grandTotal: Double = 0.0,
    val error: String? = null
)

@HiltViewModel
class AccountsViewModel @Inject constructor(
    private val overviewRepository: OverviewRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(AccountsUiState())
    val uiState: StateFlow<AccountsUiState> = _uiState.asStateFlow()

    init {
        loadAccounts()
    }

    fun loadAccounts() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = overviewRepository.getSummary()) {
                is Resource.Success -> {
                    val groups = buildGroups(result.data.accountList.filterNot { it.kind == "investment" })
                    _uiState.value = AccountsUiState(
                        isLoading = false,
                        groups = groups,
                        grandTotal = groups.sumOf { it.groupTotal }
                    )
                }

                is Resource.Error -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, error = result.message)
                }
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isRefreshing = true, error = null)
            when (val result = overviewRepository.getSummary()) {
                is Resource.Success -> {
                    val groups = buildGroups(result.data.accountList.filterNot { it.kind == "investment" })
                    _uiState.value = AccountsUiState(
                        isRefreshing = false,
                        groups = groups,
                        grandTotal = groups.sumOf { it.groupTotal }
                    )
                }

                is Resource.Error -> {
                    _uiState.value = _uiState.value.copy(isRefreshing = false, error = result.message)
                }
            }
        }
    }

    private fun buildGroups(accounts: List<AccountListRowDto>): List<AccountGroup> {
        val order = listOf("cash", "bank_debit", "ewallet", "bank_credit", "settlement", "loan", "other")
        return accounts
            .groupBy { it.kind.ifBlank { "other" } }
            .map { (kind, list) ->
                AccountGroup(
                    kind = kind,
                    kindLabel = kindLabel(kind),
                    accounts = list.sortedByDescending { kotlin.math.abs(it.balance) },
                    groupTotal = list.sumOf { it.balance }
                )
            }
            .sortedBy { order.indexOf(it.kind).let { index -> if (index == -1) 999 else index } }
    }

    companion object {
        fun kindLabel(kind: String): String = when (kind) {
            "cash" -> "\u73b0\u91d1"
            "bank_debit" -> "\u501f\u8bb0\u5361"
            "ewallet" -> "\u7b2c\u4e09\u65b9\u4f59\u989d"
            "bank_credit" -> "\u4fe1\u7528\u5361"
            "settlement" -> "\u5f80\u6765\u6b3e"
            "loan" -> "\u8d37\u6b3e"
            else -> "\u5176\u4ed6"
        }
    }
}
