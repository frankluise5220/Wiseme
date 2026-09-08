package com.mmh.app.ui.funddetail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.FundEntryDto
import com.mmh.app.data.remote.dto.FundPositionDto
import com.mmh.app.data.remote.dto.NavHistoryItem
import com.mmh.app.data.repository.FundRepository
import com.mmh.app.domain.model.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import javax.inject.Inject

data class FundDetailUiState(
    val isLoading: Boolean = false,
    val fundCode: String = "",
    val fundName: String = "",
    val position: FundPositionDto? = null,
    val entries: List<FundEntryDto> = emptyList(),
    val navHistory: List<NavHistoryItem> = emptyList(),
    val navHistoryMessage: String? = null,
    val confirmDays: Int = 0,
    val feeRate: Double = 0.0,
    val isSavingSettings: Boolean = false,
    val settingsError: String? = null,
    val error: String? = null
)

@HiltViewModel
class FundDetailViewModel @Inject constructor(
    private val fundRepository: FundRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(FundDetailUiState())
    val uiState: StateFlow<FundDetailUiState> = _uiState.asStateFlow()

    fun load(accountId: String, fundCode: String) {
        viewModelScope.launch {
            val cachedPosition = fundRepository.getCachedHolding(accountId, fundCode)
            val cachedEntries = fundRepository.getCachedFundEntries(accountId, fundCode)
            val cachedNavHistory = fundRepository.getCachedNavHistory(fundCode)
            _uiState.value = _uiState.value.copy(
                isLoading = cachedPosition == null,
                fundCode = fundCode,
                fundName = cachedPosition?.fundName
                    ?.ifBlank { cachedPosition.name }
                    ?.ifBlank { cachedEntries.firstOrNull()?.fundName.orEmpty() }
                    ?.ifBlank { fundCode }
                    ?: _uiState.value.fundName,
                position = cachedPosition ?: _uiState.value.position,
                entries = cachedEntries,
                navHistory = cachedNavHistory,
                navHistoryMessage = chartDataMessage(fundCode, cachedNavHistory, cachedEntries, null),
                settingsError = null,
                error = if (cachedPosition == null) "本地缓存暂无该基金持仓，请先完成同步。" else null
            )

            val oneYearAgo = LocalDate.now().minusYears(1)
            val startDate = listOfNotNull(firstBuyDate(cachedEntries), oneYearAgo).minOrNull()?.toString()
                ?: oneYearAgo.toString()
            when (val result = fundRepository.syncNavHistoryToCache(fundCode, startDate)) {
                is Resource.Success -> {
                    val syncedHistory = fundRepository.getCachedNavHistory(fundCode)
                    _uiState.value = _uiState.value.copy(
                        navHistory = syncedHistory,
                        navHistoryMessage = chartDataMessage(fundCode, syncedHistory, cachedEntries, null, syncAttempted = true)
                    )
                }
                is Resource.Error -> {
                    val currentHistory = _uiState.value.navHistory
                    _uiState.value = _uiState.value.copy(
                        navHistoryMessage = chartDataMessage(fundCode, currentHistory, cachedEntries, result.message)
                    )
                }
            }
        }
    }

    fun saveSettings(
        accountId: String,
        fundCode: String,
        confirmDays: Int,
        feeRate: Double,
        onSaved: () -> Unit = {}
    ) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSavingSettings = true, settingsError = null)
            when (val result = fundRepository.setFundSettings(accountId, fundCode, confirmDays, feeRate)) {
                is Resource.Success -> {
                    _uiState.value = _uiState.value.copy(
                        isSavingSettings = false,
                        confirmDays = confirmDays,
                        feeRate = feeRate,
                        settingsError = null
                    )
                    onSaved()
                }
                is Resource.Error -> {
                    _uiState.value = _uiState.value.copy(
                        isSavingSettings = false,
                        settingsError = result.message ?: "保存设置失败"
                    )
                }
            }
        }
    }

    private fun parseLocalDateOrNull(value: String?): LocalDate? {
        if (value.isNullOrBlank()) return null
        return try {
            LocalDate.parse(value.substringBefore("T"))
        } catch (e: Exception) {
            null
        }
    }

    private fun firstBuyDate(entries: List<FundEntryDto>): LocalDate? {
        return entries
            .filter { it.fundSubtype.isBlank() || it.fundSubtype == "buy" || it.fundSubtype == "regular_invest" || it.fundSubtype == "dividend_reinvest" || it.fundSubtype == "switch_in" }
            .mapNotNull { parseLocalDateOrNull(it.date) }
            .minOrNull()
    }

    private fun chartDataMessage(
        fundCode: String,
        history: List<NavHistoryItem>,
        entries: List<FundEntryDto>,
        syncError: String?,
        syncAttempted: Boolean = false
    ): String? {
        if (history.size >= 2) return null
        if (syncError != null) return "未能补齐 $fundCode 的历史净值：$syncError"
        if (syncAttempted) return "服务器暂无 $fundCode 的足够历史净值；至少需要两个净值点，才能绘制净值走势和收益走势。"
        return "正在补齐 $fundCode 的历史净值；服务器没有历史净值时，净值走势和收益走势都无法绘制。"
    }
}
