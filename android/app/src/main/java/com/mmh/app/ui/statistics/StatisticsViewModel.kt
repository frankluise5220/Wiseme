package com.mmh.app.ui.statistics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.*
import com.mmh.app.data.repository.StatisticsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Calendar
import javax.inject.Inject

/**
 * UI state for the statistics screen.
 */
data class StatisticsUiState(
    val isLoading: Boolean = false,
    val year: Int = Calendar.getInstance().get(Calendar.YEAR),
    val totalIncome: Double = 0.0,
    val totalExpense: Double = 0.0,
    val totalInvestPnL: Double = 0.0,
    val totalNet: Double = 0.0,
    val monthData: List<StatisticsMonthDto> = emptyList(),
    val incomeCategories: List<StatisticsCategoryDto> = emptyList(),
    val expenseCategories: List<StatisticsCategoryDto> = emptyList(),
    val incomeTagGroups: List<StatisticsTagGroupDto> = emptyList(),
    val expenseTagGroups: List<StatisticsTagGroupDto> = emptyList(),
    val pnlList: List<StatisticsPnLItemDto> = emptyList(),
    val error: String? = null
)

@HiltViewModel
class StatisticsViewModel @Inject constructor(
    private val statisticsRepository: StatisticsRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(StatisticsUiState())
    val uiState: StateFlow<StatisticsUiState> = _uiState.asStateFlow()

    init {
        loadStatistics()
    }

    fun loadStatistics(year: Int? = null) {
        viewModelScope.launch {
            val targetYear = year ?: _uiState.value.year
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = statisticsRepository.getStatistics(year = targetYear)) {
                is com.mmh.app.domain.model.Resource.Success -> {
                    val d = result.data
                    _uiState.value = StatisticsUiState(
                        isLoading = false,
                        year = d.year,
                        totalIncome = d.totalIncome,
                        totalExpense = d.totalExpense,
                        totalInvestPnL = d.totalInvestPnL,
                        totalNet = d.totalNet,
                        monthData = d.monthData,
                        incomeCategories = d.incomeCategories,
                        expenseCategories = d.expenseCategories,
                        incomeTagGroups = d.incomeTagGroups,
                        expenseTagGroups = d.expenseTagGroups,
                        pnlList = d.pnlList
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

    fun changeYear(delta: Int) {
        val newYear = _uiState.value.year + delta
        if (newYear in 2000..2100) {
            loadStatistics(newYear)
        }
    }

    fun retry() = loadStatistics()
}
