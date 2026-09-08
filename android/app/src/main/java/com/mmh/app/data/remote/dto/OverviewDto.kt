package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Overview / Dashboard DTOs.
 * API: GET /api/v1... (overview data is composed from multiple endpoints)
 */

/** Net worth data point for chart */
@Serializable
data class NetWorthPointDto(
    val date: String = "",
    val totalAssets: Double = 0.0,
    val totalLiabilities: Double = 0.0,
    val netWorth: Double = 0.0
)

/** Category summary */
@Serializable
data class CategorySummaryDto(
    val categoryId: String? = null,
    val categoryName: String = "",
    val type: String = "expense",
    val amount: Double = 0.0,
    val percentage: Double = 0.0,
    val count: Int = 0
)

/** Monthly summary */
@Serializable
data class MonthlySummaryDto(
    val month: String = "",   // "YYYY-MM"
    val income: Double = 0.0,
    val expense: Double = 0.0,
    val net: Double = 0.0
)

/** Account overview summary */
@Serializable
data class AccountOverviewDto(
    val id: String = "",
    val name: String = "",
    val kind: String = "other",
    val balance: Double = 0.0,
    val currency: String = "CNY",
    val groupName: String? = null,
    val institutionName: String? = null
)

/** Overview data assembled from multiple API calls */
data class OverviewData(
    val totalAssets: Double = 0.0,
    val totalLiabilities: Double = 0.0,
    val netWorth: Double = 0.0,
    val accounts: List<AccountOverviewDto> = emptyList(),
    val recentTransactions: List<TransactionDto> = emptyList(),
    val monthlySummary: List<MonthlySummaryDto> = emptyList(),
    val categorySummary: List<CategorySummaryDto> = emptyList()
)

/** Category entity */
@Serializable
data class CategoryDto(
    val id: String = "",
    val name: String = "",
    val type: String = "expense",
    val parentId: String? = null,
    val sortOrder: Int? = null
)

/** Category list response */
@Serializable
data class CategoryListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val categories: List<CategoryDto>? = null
)

/** Tag entity */
@Serializable
data class TagDto(
    val id: String = "",
    val name: String = "",
    val color: String? = null
)

/** Tag list response */
@Serializable
data class TagListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val tags: List<TagDto> = emptyList()
)

/** Institution entity */
@Serializable
data class InstitutionCreateResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val institution: InstitutionDto? = null
)

/** Account group list response */
@Serializable
data class AccountGroupListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val groups: List<AccountGroupDto>? = null
)

/** Auth verify request */
@Serializable
data class AuthVerifyRequest(
    val username: String,
    val password: String
)

/** Auth verify response */
@Serializable
data class AuthVerifyResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val username: String? = null,
    val systemVerified: Boolean? = null,
    val householdId: String? = null,
    val householdName: String? = null
)

/** Ping response */
@Serializable
data class PingResponse(
    val status: String = "",
    val timestamp: String = ""
)

// ── Overview summary (GET /api/v1/overview/summary) ──────────────────────────

/** 资产分布单项 */
@Serializable
data class AssetDistributionItemDto(
    val kind: String = "",
    val label: String = "",
    val value: Double = 0.0,
    val pct: Double = 0.0
)

/**
 * 账户余额展示行（投资账户 balance 字段即 marketValue）。
 *
 * balance 是账户原币金额；convertedBalance 是按家庭本位币 baseCurrency 折算后的金额，
 * 缺少汇率时为 null，客户端不得按 1:1 当作本位币展示。
 */
@Serializable
data class AccountListRowDto(
    val id: String = "",
    val name: String = "",
    val kind: String = "other",
    val balance: Double = 0.0,
    val groupName: String? = null,
    val institutionName: String? = null,
    val currency: String = "CNY",
    val convertedBalance: Double? = null,
    val fxRate: Double? = null,
    val fxRateDate: String? = null,
    val fxRateMissing: Boolean = false
)

/** 信用卡账户展示行。金额字段为原币，converted* 为折算到本位币的镜像值。 */
@Serializable
data class CreditAccountRowDto(
    val id: String = "",
    val name: String = "",
    val kind: String = "bank_credit",
    val balance: Double = 0.0,
    val groupName: String? = null,
    val institutionName: String? = null,
    val currency: String = "CNY",
    val convertedBalance: Double? = null,
    val fxRate: Double? = null,
    val fxRateDate: String? = null,
    val fxRateMissing: Boolean = false,
    val creditLimit: Double = 0.0,
    val availableLimit: Double = 0.0,
    val billingDay: Int? = null,
    val repaymentDay: Int? = null,
    val currentBill: Double = 0.0,
    val paid: Double = 0.0,
    val remain: Double = 0.0,
    val dueDate: String? = null,
    val convertedCreditLimit: Double? = null,
    val convertedCurrentBill: Double? = null,
    val convertedPaid: Double? = null,
    val convertedCurrentAmount: Double? = null
)

/** 首页分类汇总。字段名与 /api/v1/overview/summary 保持一致。 */
@Serializable
data class AccountTypeTotalsDto(
    val cash: Double = 0.0,
    val bankDebit: Double = 0.0,
    val ewallet: Double = 0.0,
    val deposit: Double = 0.0,
    val investmentMarketValue: Double = 0.0,
    val investmentCost: Double = 0.0,
    val investmentFloatingPnL: Double = 0.0,
    val fixedAssetMarketValue: Double = 0.0,
    val fixedAssetCost: Double = 0.0,
    val creditUsed: Double = 0.0,
    val creditLimit: Double = 0.0,
    val creditAvailable: Double = 0.0,
    val creditCurrentBill: Double = 0.0,
    val loan: Double = 0.0,
    val loanReceivable: Double = 0.0,
    val other: Double = 0.0,
    val liquidAssets: Double = 0.0,
    val liabilities: Double = 0.0,
    val dailyNetWorth: Double = 0.0,
    val totalNetWorth: Double = 0.0
)

/** 投资持仓摘要行（Top N，按市值降序）。converted* 为折算到本位币的镜像值。 */
@Serializable
data class TopPositionRowDto(
    val accountId: String = "",
    val fundCode: String = "",
    val name: String = "",
    val marketValue: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val floatingPnLRate: Double = 0.0,
    val currency: String = "CNY",
    val convertedMarketValue: Double? = null,
    val convertedFloatingPnL: Double? = null,
    val fxRate: Double? = null,
    val fxRateMissing: Boolean = false
)

/**
 * 固定资产行。固定资产（房产、车辆等）不再计入投资市值，单独展示。
 * marketValue 是原币金额，convertedMarketValue 是折算到本位币的金额。
 */
@Serializable
data class FixedAssetRowDto(
    val accountId: String = "",
    val name: String = "",
    val assetType: String? = null,
    val groupName: String? = null,
    val marketValue: Double = 0.0,
    val cost: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val floatingPnLRate: Double = 0.0,
    val currency: String = "CNY",
    val convertedMarketValue: Double? = null,
    val fxRate: Double? = null,
    val fxRateDate: String? = null,
    val fxRateMissing: Boolean = false
)

/** 总览汇总数据。与网页总览页同一计算源，金额一致。 */
@Serializable
data class OverviewSummaryDto(
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
    val dailyAssetDistribution: List<AssetDistributionItemDto> = emptyList(),
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
    val missingFxCurrencies: List<String> = emptyList()
)

/** GET /api/v1/overview/summary 响应 */
@Serializable
data class OverviewSummaryResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val data: OverviewSummaryDto? = null
)
