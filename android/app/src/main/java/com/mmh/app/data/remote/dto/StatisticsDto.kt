package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

// ── Statistics (GET /api/v1/statistics) ──────────────────────────

@Serializable
data class StatisticsMonthDto(
    val month: String = "",
    val income: Double = 0.0,
    val expense: Double = 0.0,
    val investPnL: Double = 0.0,
    val netTotal: Double = 0.0,
    val cumNet: Double = 0.0
)

@Serializable
data class StatisticsCategoryDto(
    val name: String = "",
    val value: Double = 0.0,
    val pct: Double = 0.0
)

@Serializable
data class StatisticsTagGroupDto(
    val id: String = "",
    val name: String = "",
    val color: String = "#3B82F6",
    val value: Double = 0.0,
    val pct: Double = 0.0
)

@Serializable
data class StatisticsPnLItemDto(
    val id: String = "",
    val date: String = "",
    val fundCode: String = "",
    val fundName: String = "",
    val subtype: String = "",
    val amount: Double = 0.0,
    val profit: Double = 0.0,
    val profitRate: Double = 0.0
)

@Serializable
data class StatisticsData(
    val year: Int = 0,
    val totalIncome: Double = 0.0,
    val totalExpense: Double = 0.0,
    val totalInvestPnL: Double = 0.0,
    val totalNet: Double = 0.0,
    val monthData: List<StatisticsMonthDto> = emptyList(),
    val incomeCategories: List<StatisticsCategoryDto> = emptyList(),
    val expenseCategories: List<StatisticsCategoryDto> = emptyList(),
    val incomeTagGroups: List<StatisticsTagGroupDto> = emptyList(),
    val expenseTagGroups: List<StatisticsTagGroupDto> = emptyList(),
    val pnlList: List<StatisticsPnLItemDto> = emptyList()
)

@Serializable
data class StatisticsResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val data: StatisticsData? = null
)
