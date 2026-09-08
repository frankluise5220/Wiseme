package com.mmh.app.ui.funds

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.FundClearedPositionDto
import com.mmh.app.data.remote.dto.FundEntryDto
import com.mmh.app.data.remote.dto.FundPositionDto
import com.mmh.app.data.remote.dto.FundShellDataResponse
import com.mmh.app.data.remote.dto.InvestmentAccountDto
import com.mmh.app.data.repository.AccountRepository
import com.mmh.app.data.repository.FundRepository
import com.mmh.app.domain.model.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

data class FundsUiState(
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val accounts: List<InvestmentAccountDto> = emptyList(),
    val selectedAccountId: String = "",
    val selectedFundCode: String = "",
    val positions: List<FundPositionDto> = emptyList(),
    val clearedPositions: List<FundClearedPositionDto> = emptyList(),
    val entries: List<FundEntryDto> = emptyList(),
    val totalMarketValue: Double = 0.0,
    val totalCost: Double = 0.0,
    val totalHistoricalProfit: Double = 0.0,
    val error: String? = null,
)

@HiltViewModel
class FundsViewModel @Inject constructor(
    private val accountRepository: AccountRepository,
    private val fundRepository: FundRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(FundsUiState())
    val uiState: StateFlow<FundsUiState> = _uiState.asStateFlow()

    private val shellCache = mutableMapOf<String, FundShellDataResponse>()

    init {
        loadInitial()
    }

    fun loadInitial() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                val cachedAccounts = accountRepository.getCachedInvestmentAccounts()
                if (cachedAccounts.isNotEmpty()) {
                    val selectedAccountId = _uiState.value.selectedAccountId
                        .takeIf { current -> cachedAccounts.any { it.id == current } }
                        ?: cachedAccounts.firstOrNull()?.id.orEmpty()

                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        accounts = cachedAccounts,
                        selectedAccountId = selectedAccountId,
                    )

                    if (selectedAccountId.isNotBlank()) {
                        loadCachedFundData(selectedAccountId)
                    }
                    return@launch
                }

                when (val accountResult = accountRepository.getInvestmentAccounts()) {
                    is Resource.Success -> {
                        val accounts = accountResult.data
                        val selectedAccountId = _uiState.value.selectedAccountId
                            .takeIf { current -> accounts.any { it.id == current } }
                            ?: accounts.firstOrNull()?.id.orEmpty()

                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            accounts = accounts,
                            selectedAccountId = selectedAccountId,
                        )

                        if (selectedAccountId.isNotBlank()) {
                            loadFundData(selectedAccountId, false)
                        }
                    }

                    is Resource.Error -> {
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            error = accountResult.message,
                        )
                    }
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load funds initial")
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = e.message ?: "加载基金持仓失败",
                )
            }
        }
    }

    fun selectAccount(accountId: String) {
        if (accountId.isBlank() || accountId == _uiState.value.selectedAccountId) return
        _uiState.value = _uiState.value.copy(
            selectedAccountId = accountId,
            selectedFundCode = "",
            positions = emptyList(),
            clearedPositions = emptyList(),
            entries = emptyList(),
            totalMarketValue = 0.0,
            totalCost = 0.0,
            totalHistoricalProfit = 0.0,
            isRefreshing = true,
            error = null
        )

        loadCachedFundData(accountId)
    }

    fun selectFund(fundCode: String) {
        _uiState.value = _uiState.value.copy(selectedFundCode = fundCode)
    }

    fun refresh() {
        val accountId = _uiState.value.selectedAccountId
        if (accountId.isBlank()) {
            loadInitial()
        } else {
            loadFundData(accountId, true)
        }
    }

    private fun loadFundData(accountId: String, refresh: Boolean) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isLoading = !refresh,
                isRefreshing = refresh,
                error = null,
            )

            try {
                when (val fundResult = fundRepository.getShellData(accountId = accountId)) {
                    is Resource.Success -> {
                        val data = fundResult.data
                        shellCache[accountId] = data
                        applyShellData(accountId, data, isRefreshing = false)
                    }

                    is Resource.Error -> {
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            isRefreshing = false,
                            error = fundResult.message,
                        )
                    }
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load fund shell data")
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    isRefreshing = false,
                    error = e.message ?: "加载基金数据失败",
                )
            }
        }
    }

    private fun loadCachedFundData(accountId: String) {
        viewModelScope.launch {
            val positions = fundRepository.getCachedHoldings(accountId)
            val nextFundCode = _uiState.value.selectedFundCode.takeIf { code ->
                positions.any { it.fundCode == code }
            } ?: positions.maxByOrNull { it.marketValue }?.fundCode.orEmpty()

            _uiState.value = _uiState.value.copy(
                selectedAccountId = accountId,
                isLoading = false,
                isRefreshing = false,
                positions = positions,
                clearedPositions = emptyList(),
                entries = emptyList(),
                totalMarketValue = positions.sumOf { it.marketValue },
                totalCost = positions.sumOf { it.cost },
                totalHistoricalProfit = positions.sumOf { it.historicalProfit },
                selectedFundCode = nextFundCode,
                error = null,
            )
        }
    }

    private fun applyShellData(
        accountId: String,
        data: FundShellDataResponse,
        isRefreshing: Boolean,
    ) {
        val nextFundCode = _uiState.value.selectedFundCode.takeIf { code ->
            data.positions.any { it.fundCode == code } || data.clearedPositions.any { it.fundCode == code }
        } ?: data.selectedFundCode
            .takeIf { code -> code.isNotBlank() }
        ?: data.positions.maxByOrNull { it.marketValue }?.fundCode
        ?: data.clearedPositions.maxByOrNull { it.clearedDate }?.fundCode
        ?: ""

        _uiState.value = _uiState.value.copy(
            selectedAccountId = accountId,
            isLoading = false,
            isRefreshing = isRefreshing,
            positions = data.positions,
            clearedPositions = data.clearedPositions,
            entries = data.allEntries,
            totalMarketValue = data.totalMarketValue,
            totalCost = data.totalCost,
            totalHistoricalProfit = data.totalHistoricalProfit,
            selectedFundCode = nextFundCode,
            error = null,
        )
    }
}
