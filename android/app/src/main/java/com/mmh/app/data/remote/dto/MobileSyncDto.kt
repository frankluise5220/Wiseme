package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class MobileSyncResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val serverTime: String = "",
    val hasMore: Boolean = false,
    val accounts: List<MobileSyncAccountDto> = emptyList(),
    val categories: List<CategoryItemDto> = emptyList(),
    val transactions: List<TransactionDto> = emptyList(),
    val deletedTransactionIds: List<String> = emptyList(),
    val fundHoldings: List<MobileSyncFundHoldingDto> = emptyList(),
    val fundConfirmDays: List<MobileSyncFundConfirmDaysDto> = emptyList(),
    val fundFeeRates: List<MobileSyncFundFeeRateDto> = emptyList(),
    val fundNav: List<MobileSyncFundNavDto> = emptyList(),
    val regularInvestPlans: List<RegularInvestPlanDto> = emptyList(),
    val stockHoldings: List<MobileSyncStockHoldingDto> = emptyList(),
    val stockTransactions: List<MobileSyncStockTransactionDto> = emptyList(),
    val deletedStockTransactionIds: List<String> = emptyList(),
    val propertyAssets: List<MobileSyncPropertyAssetDto> = emptyList(),
    val propertyTransactions: List<MobileSyncPropertyTransactionDto> = emptyList(),
    val deletedPropertyTransactionIds: List<String> = emptyList()
)

@Serializable
data class MobileSyncStockHoldingDto(
    val id: String = "",
    val accountId: String = "",
    val securityId: String = "",
    val market: String = "",
    val stockCode: String = "",
    val stockName: String? = null,
    val quantity: Double = 0.0,
    val avgCost: Double = 0.0,
    val cost: Double = 0.0,
    val latestPrice: Double? = null,
    val marketValue: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val historicalProfit: Double = 0.0,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncStockTransactionDto(
    val id: String = "",
    val linkId: String? = null,
    val stockAccountId: String = "",
    val cashAccountId: String? = null,
    val cashEntryId: String? = null,
    val securityId: String? = null,
    val market: String = "",
    val stockCode: String = "",
    val stockName: String? = null,
    val action: String = "buy",
    val source: String? = null,
    val tradeDate: String = "",
    val settleDate: String? = null,
    val grossAmount: Double = 0.0,
    val netAmount: Double? = null,
    val quantity: Double? = null,
    val price: Double? = null,
    val fee: Double? = null,
    val commission: Double? = null,
    val stampTax: Double? = null,
    val transferFee: Double? = null,
    val exchangeFee: Double? = null,
    val regulatoryFee: Double? = null,
    val otherFee: Double? = null,
    val realizedProfit: Double? = null,
    val externalLinkId: String? = null,
    val brokerTradeId: String? = null,
    val note: String? = null,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncPropertyAssetDto(
    val id: String = "",
    val accountId: String = "",
    val name: String = "",
    val propertyType: String? = null,
    val address: String? = null,
    val currency: String = "CNY",
    val purchaseDate: String? = null,
    val purchasePrice: Double? = null,
    val cost: Double = 0.0,
    val marketValue: Double = 0.0,
    val latestValuationDate: String? = null,
    val status: String? = null,
    val note: String? = null,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncPropertyTransactionDto(
    val id: String = "",
    val linkId: String? = null,
    val accountId: String = "",
    val cashAccountId: String? = null,
    val cashEntryId: String? = null,
    val propertyAssetId: String? = null,
    val action: String = "buy",
    val source: String? = null,
    val tradeDate: String = "",
    val settlementDate: String? = null,
    val amount: Double = 0.0,
    val fee: Double? = null,
    val tax: Double? = null,
    val realizedProfit: Double? = null,
    val note: String? = null,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncAccountDto(
    val id: String = "",
    val name: String = "",
    val balance: Double = 0.0,
    val kind: String = "other",
    val debtDirection: String? = null,
    val currency: String = "CNY",
    val isActive: Boolean = true,
    val isPlaceholder: Boolean = false,
    val investProductType: String? = null,
    val tradingCalendar: String? = null,
    val creditLimit: Double? = null,
    val billingDay: Int? = null,
    val repaymentDay: Int? = null,
    val numberMasked: String? = null,
    val institutionId: String? = null,
    val institutionName: String? = null,
    val groupId: String = "",
    val groupName: String? = null,
    val costBasisMethod: String? = null,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundHoldingDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val fundName: String? = null,
    val units: Double = 0.0,
    val avgCost: Double = 0.0,
    val cost: Double = 0.0,
    val nav: Double? = null,
    val navDate: String? = null,
    val pendingCost: Double = 0.0,
    val historicalProfit: Double = 0.0,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundConfirmDaysDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val days: Int = 0,
    val redeemCostDays: Int = 1,
    val arrivalDays: Int = 0,
    val effectiveDate: String = "",
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundFeeRateDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val rate: Double = 0.0,
    val feeType: String = "buy",
    val effectiveDate: String = "",
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundNavDto(
    val id: String = "",
    val fundCode: String = "",
    val navDate: String = "",
    val nav: Double = 0.0,
    val cumNav: Double? = null,
    val name: String? = null,
    val updatedAt: String = ""
)
