package com.mmh.app.data.remote.dto

/**
 * Stock holding row shown in the Android invest overview and stock detail pages.
 * Data comes from the local Room cache synced from GET /api/v1/mobile/sync.
 */
data class StockHoldingDto(
    val id: String = "",
    val accountId: String = "",
    val securityId: String = "",
    val market: String = "",
    val stockCode: String = "",
    val stockName: String = "",
    val quantity: Double = 0.0,
    val avgCost: Double = 0.0,
    val cost: Double = 0.0,
    val latestPrice: Double? = null,
    val marketValue: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val historicalProfit: Double = 0.0
)

/**
 * Property asset row shown in the Android invest overview.
 * Data comes from the local Room cache synced from GET /api/v1/mobile/sync.
 */
data class PropertyAssetDto(
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
    val note: String? = null
)
