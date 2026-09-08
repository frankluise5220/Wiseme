package com.mmh.app.ui.invest

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.repository.AccountRepository
import com.mmh.app.data.repository.FundRepository
import com.mmh.app.data.repository.PropertyRepository
import com.mmh.app.data.repository.StockRepository
import com.mmh.app.domain.model.Resource
import com.mmh.app.ui.util.formatAccountDisplayName
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import timber.log.Timber

data class InvestmentAccountOverviewRow(
    val accountId: String,
    val accountName: String,
    val investProductType: String = "fund",
    val marketValue: Double,
    val totalCost: Double,
    val floatingPnL: Double,
    val positionCount: Int
)

data class InvestOverviewUiState(
    val isLoading: Boolean = false,
    val totalMarketValue: Double = 0.0,
    val totalCost: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val accounts: List<InvestmentAccountOverviewRow> = emptyList(),
    val error: String? = null
)

@HiltViewModel
class InvestOverviewViewModel @Inject constructor(
    private val accountRepository: AccountRepository,
    private val fundRepository: FundRepository,
    private val stockRepository: StockRepository,
    private val propertyRepository: PropertyRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(InvestOverviewUiState())
    val uiState: StateFlow<InvestOverviewUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                val cachedAccounts = accountRepository.getCachedInvestmentAccounts()
                if (cachedAccounts.isNotEmpty()) {
                    val holdings = fundRepository.getCachedHoldings()
                    val stockHoldings = stockRepository.getCachedHoldings()
                    val propertyAssets = propertyRepository.getCachedAssets()
                    val rows = cachedAccounts.map { account ->
                        val scopedHoldings = holdings.filter { it.accountId == account.id }
                        val scopedStockHoldings = stockHoldings.filter { it.accountId == account.id }
                        val scopedPropertyAssets = propertyAssets.filter { it.accountId == account.id }
                        InvestmentAccountOverviewRow(
                            accountId = account.id,
                            accountName = formatAccountDisplayName(account.name, account.institutionName),
                            investProductType = account.investProductType,
                            marketValue = scopedHoldings.sumOf { it.marketValue }
                                + scopedStockHoldings.sumOf { it.marketValue }
                                + scopedPropertyAssets.sumOf { it.marketValue },
                            totalCost = scopedHoldings.sumOf { it.cost }
                                + scopedStockHoldings.sumOf { it.cost }
                                + scopedPropertyAssets.sumOf { it.cost },
                            floatingPnL = scopedHoldings.sumOf { it.marketValue - it.cost }
                                + scopedStockHoldings.sumOf { it.floatingPnL }
                                + scopedPropertyAssets.sumOf { it.marketValue - it.cost },
                            positionCount = scopedHoldings.size + scopedStockHoldings.size + scopedPropertyAssets.size
                        )
                    }
                    _uiState.value = InvestOverviewUiState(
                        isLoading = false,
                        totalMarketValue = rows.sumOf { it.marketValue },
                        totalCost = rows.sumOf { it.totalCost },
                        floatingPnL = rows.sumOf { it.floatingPnL },
                        accounts = rows.sortedByDescending { kotlin.math.abs(it.marketValue) }
                    )
                    return@launch
                }

                when (val accountResult = accountRepository.getInvestmentAccounts()) {
                    is Resource.Success -> {
                        val accountRows = mutableListOf<InvestmentAccountOverviewRow>()

                        for (account in accountResult.data) {
                            when (val shellResult = fundRepository.getShellData(accountId = account.id)) {
                                is Resource.Success -> {
                                    val shell = shellResult.data
                                    accountRows += InvestmentAccountOverviewRow(
                                        accountId = account.id,
                                        accountName = formatAccountDisplayName(account.name, account.institutionName),
                                        investProductType = account.investProductType,
                                        marketValue = shell.totalMarketValue,
                                        totalCost = shell.totalCost,
                                        floatingPnL = shell.totalMarketValue - shell.totalCost,
                                        positionCount = shell.positions.size
                                    )
                                }

                                is Resource.Error -> {
                                    _uiState.value = InvestOverviewUiState(
                                        isLoading = false,
                                        error = shellResult.message
                                    )
                                    return@launch
                                }
                            }
                        }

                        _uiState.value = InvestOverviewUiState(
                            isLoading = false,
                            totalMarketValue = accountRows.sumOf { it.marketValue },
                            totalCost = accountRows.sumOf { it.totalCost },
                            floatingPnL = accountRows.sumOf { it.floatingPnL },
                            accounts = accountRows.sortedByDescending { kotlin.math.abs(it.marketValue) }
                        )
                    }

                    is Resource.Error -> _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = accountResult.message
                    )
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load invest overview")
                _uiState.value = InvestOverviewUiState(
                    isLoading = false,
                    error = e.message ?: "加载投资总览失败"
                )
            }
        }
    }

}
