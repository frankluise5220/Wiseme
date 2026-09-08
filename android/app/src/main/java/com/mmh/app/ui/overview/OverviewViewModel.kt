package com.mmh.app.ui.overview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.AccountTypeTotalsDto
import com.mmh.app.data.remote.dto.AccountListRowDto
import com.mmh.app.data.remote.dto.AssetDistributionItemDto
import com.mmh.app.data.remote.dto.CreditAccountRowDto
import com.mmh.app.data.remote.dto.FixedAssetRowDto
import com.mmh.app.data.remote.dto.TopPositionRowDto
import com.mmh.app.data.repository.OverviewRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the overview screen.
 * Fields mirror GET /api/v1/overview/summary (single source of truth with web).
 */
data class OverviewUiState(
    val isLoading: Boolean = false,
    val netWorth: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val totalCost: Double = 0.0,
    val monthIncome: Double = 0.0,
    val monthExpense: Double = 0.0,
    val assetDistribution: List<AssetDistributionItemDto> = emptyList(),
    val accountList: List<AccountListRowDto> = emptyList(),
    val topPositions: List<TopPositionRowDto> = emptyList(),
    val investmentAccountList: List<TopPositionRowDto> = emptyList(),
    val dailyNetWorth: Double = 0.0,
    val dailyAccountList: List<AccountListRowDto> = emptyList(),
    val creditAccountList: List<CreditAccountRowDto> = emptyList(),
    val debtAccountList: List<AccountListRowDto> = emptyList(),
    val accountTypeTotals: AccountTypeTotalsDto = AccountTypeTotalsDto(),
    val creditUsedTotal: Double = 0.0,
    val creditLimitTotal: Double = 0.0,
    val creditAvailableTotal: Double = 0.0,
    val creditCurrentBillTotal: Double = 0.0,
    val investmentMarketValue: Double = 0.0,
    val investmentCost: Double = 0.0,
    val investmentFloatingPnL: Double = 0.0,
    val investmentFloatingPnLRate: Double = 0.0,
    val fixedAssetAccountList: List<FixedAssetRowDto> = emptyList(),
    val fixedAssetCount: Int = 0,
    val fixedAssetMarketValue: Double = 0.0,
    val fixedAssetCost: Double = 0.0,
    val fixedAssetFloatingPnL: Double = 0.0,
    val fixedAssetFloatingPnLRate: Double = 0.0,
    val baseCurrency: String = "CNY",
    val missingFxCurrencies: List<String> = emptyList(),
    val error: String? = null
)

@HiltViewModel
class OverviewViewModel @Inject constructor(
    private val overviewRepository: OverviewRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(OverviewUiState())
    val uiState: StateFlow<OverviewUiState> = _uiState.asStateFlow()

    fun loadOverview() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = overviewRepository.getSummary()) {
                is com.mmh.app.domain.model.Resource.Success -> {
                    val d = result.data
                    _uiState.value = OverviewUiState(
                        isLoading = false,
                        netWorth = d.netWorth,
                        floatingPnL = d.floatingPnL,
                        totalCost = d.totalCost,
                        monthIncome = d.monthIncome,
                        monthExpense = d.monthExpense,
                        assetDistribution = d.assetDistribution,
                        accountList = d.accountList,
                        topPositions = d.topPositions,
                        investmentAccountList = d.investmentAccountList,
                        dailyNetWorth = d.dailyNetWorth,
                        dailyAccountList = d.dailyAccountList,
                        creditAccountList = d.creditAccountList,
                        debtAccountList = d.debtAccountList,
                        accountTypeTotals = d.accountTypeTotals,
                        creditUsedTotal = d.creditUsedTotal,
                        creditLimitTotal = d.creditLimitTotal,
                        creditAvailableTotal = d.creditAvailableTotal,
                        creditCurrentBillTotal = d.creditCurrentBillTotal,
                        investmentMarketValue = d.investmentMarketValue,
                        investmentCost = d.investmentCost,
                        investmentFloatingPnL = d.investmentFloatingPnL,
                        investmentFloatingPnLRate = d.investmentFloatingPnLRate,
                        fixedAssetAccountList = d.fixedAssetAccountList,
                        fixedAssetCount = d.fixedAssetCount,
                        fixedAssetMarketValue = d.fixedAssetMarketValue,
                        fixedAssetCost = d.fixedAssetCost,
                        fixedAssetFloatingPnL = d.fixedAssetFloatingPnL,
                        fixedAssetFloatingPnLRate = d.fixedAssetFloatingPnLRate,
                        baseCurrency = d.baseCurrency,
                        missingFxCurrencies = d.missingFxCurrencies
                    )
                }
                is com.mmh.app.domain.model.Resource.Error -> {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = result.message
                    )
                }
            }
        }
    }

    fun retry() = loadOverview()
}
