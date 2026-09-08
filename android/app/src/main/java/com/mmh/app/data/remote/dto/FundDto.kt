package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Fund-related DTOs.
 * API: /api/v1/fund/shell-data, /api/v1/fund/entries, /api/v1/fund/nav
 * API: /api/v1/fund/position, /api/v1/fund/confirm-days, /api/v1/fund/fee-rate
 */

/** Fund position from shell-data API */
@Serializable
data class FundPositionDto(
    val accountId: String = "",
    val fundCode: String = "",
    val name: String = "",
    val fundName: String = "",
    val fundProductType: String = "fund",
    val units: Double = 0.0,
    val availableUnits: Double = 0.0,
    val cost: Double = 0.0,
    val marketValue: Double = 0.0,
    val nav: Double? = null,
    val navDate: String? = null,
    val floatingPnL: Double = 0.0,
    val floatingPnLRate: Double? = null,
    val profit: Double = 0.0,
    val profitRate: Double? = null,
    val dayProfit: Double? = null,
    val historicalProfit: Double = 0.0,
    val pendingCost: Double = 0.0,
    val pendingUnits: Double = 0.0
)

/** Cleared (closed) position */
@Serializable
data class FundClearedPositionDto(
    val fundCode: String = "",
    val name: String = "",
    val fundName: String = "",
    val fundProductType: String = "fund",
    val cost: Double = 0.0,
    val marketValue: Double = 0.0,
    val profit: Double = 0.0,
    val profitRate: Double? = null,
    val historicalProfit: Double = 0.0,
    val totalInvested: Double = 0.0,
    val returnRate: Double = 0.0,
    val firstBuyDate: String = "",
    val totalBuyAmount: Double = 0.0,
    val totalRedeemAmount: Double = 0.0,
    val clearedDate: String = ""
)

/** Fund entry in the transaction list */
@Serializable
data class FundEntryDto(
    val id: String = "",
    val date: String = "",
    val type: String = "",
    val fundSubtype: String = "",
    val amount: Double = 0.0,
    val fundCode: String? = null,
    val fundName: String? = null,
    val accountId: String = "",
    val accountName: String = "",
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val categoryName: String = "",
    val note: String? = null,
    val fundUnits: Double? = null,
    val fundNav: Double? = null,
    val fundFee: Double? = null,
    val fundConfirmDate: String? = null,
    val fundArrivalDate: String? = null,
    val fundArrivalAmount: Double? = null,
    val shares: Double? = null,
    val nav: Double? = null,
    val fee: Double? = null
)

/** Shell data response */
@Serializable
data class FundShellDataResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val positions: List<FundPositionDto> = emptyList(),
    val clearedPositions: List<FundClearedPositionDto> = emptyList(),
    val allEntries: List<FundEntryDto> = emptyList(),
    val selectedFundCode: String = "",
    val totalMarketValue: Double = 0.0,
    val totalCost: Double = 0.0,
    val totalHistoricalProfit: Double = 0.0,
    val confirmDaysMap: Map<String, Int> = emptyMap(),
    val feeRateMap: Map<String, String> = emptyMap(),
    val pendingByCode: Map<String, Double> = emptyMap()
)

/** NAV record */
@Serializable
data class NavRecordDto(
    val fundCode: String = "",
    val navDate: String = "",
    val nav: Double = 0.0,
    val cumNav: Double? = null,
    val fundName: String? = null
)

/** Confirm days record */
@Serializable
data class FundConfirmDaysDto(
    val id: String? = null,
    val accountId: String = "",
    val fundCode: String = "",
    val days: Int = 0,
    val effectiveDate: String? = null
)

/** Fee rate record */
@Serializable
data class FundFeeRateDto(
    val id: String? = null,
    val accountId: String = "",
    val fundCode: String = "",
    val feeType: String = "buy",
    val rate: Double = 0.0,
    val effectiveDate: String? = null
)

@Serializable
data class SetFundConfirmDaysRequest(
    val accountId: String,
    val fundCode: String,
    val days: Int
)

@Serializable
data class SetFundFeeRateRequest(
    val accountId: String,
    val fundCode: String,
    val rate: Double,
    val feeType: String = "buy"
)

/** Fund position creation request */
@Serializable
data class CreateFundPositionRequest(
    val accountId: String,
    val fundCode: String,
    val fundName: String = "",
    val units: Double = 0.0,
    val cost: Double = 0.0,
    val fundProductType: String = "fund"
)

/** Fund day PnL record */
@Serializable
data class FundDayPnlDto(
    val date: String = "",
    val mv: Double = 0.0,
    val pnl: Double? = null
)

/** Fund month PnL record */
@Serializable
data class FundMonthPnlDto(
    val month: Int = 0,
    val mv: Double? = null,
    val pnl: Double? = null
)

/** Daily PnL response */
@Serializable
data class DailyPnlResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val days: List<FundDayPnlDto> = emptyList(),
    val months: List<FundMonthPnlDto> = emptyList()
)

/** Fund holdings (for invest page) */
@Serializable
data class FundHoldingDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val fundName: String = "",
    val fundProductType: String = "fund",
    val units: Double = 0.0,
    val availableUnits: Double = 0.0,
    val cost: Double = 0.0,
    val nav: Double? = null,
    val navDate: String? = null,
    val marketValue: Double = 0.0
)

/** NAV history point from GET /api/v1/fund/nav/history */
@Serializable
data class NavHistoryItem(
    val date: String = "",
    val nav: Double = 0.0,
    val cumNav: Double? = null
)

/** NAV history response */
@Serializable
data class NavHistoryResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val data: List<NavHistoryItem> = emptyList()
)

@Serializable
data class PreloadNavRequest(
    val fundCode: String,
    val startDate: String,
    val endDate: String
)
