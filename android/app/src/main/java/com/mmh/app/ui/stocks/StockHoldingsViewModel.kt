package com.mmh.app.ui.stocks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.repository.StockRepository
import com.mmh.app.data.remote.dto.StockHoldingDto
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class StockHoldingsUiState(
    val isLoading: Boolean = false,
    val holdings: List<StockHoldingDto> = emptyList(),
    val totalMarketValue: Double = 0.0,
    val totalCost: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val error: String? = null
)

@HiltViewModel
class StockHoldingsViewModel @Inject constructor(
    private val stockRepository: StockRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(StockHoldingsUiState())
    val uiState: StateFlow<StockHoldingsUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load(accountId: String? = null) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val holdings = stockRepository.getCachedHoldings(accountId)
            _uiState.value = StockHoldingsUiState(
                isLoading = false,
                holdings = holdings.sortedByDescending { kotlin.math.abs(it.marketValue) },
                totalMarketValue = holdings.sumOf { it.marketValue },
                totalCost = holdings.sumOf { it.cost },
                floatingPnL = holdings.sumOf { it.floatingPnL }
            )
        }
    }
}
