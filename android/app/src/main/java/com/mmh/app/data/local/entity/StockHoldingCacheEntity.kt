package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local cache for stock holdings synced from GET /api/v1/mobile/sync.
 */
@Entity(tableName = "stock_holding_cache")
data class StockHoldingCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "security_id") val securityId: String,
    val market: String,
    @ColumnInfo(name = "stock_code") val stockCode: String,
    @ColumnInfo(name = "stock_name") val stockName: String?,
    val quantity: Double,
    @ColumnInfo(name = "avg_cost") val avgCost: Double,
    val cost: Double,
    @ColumnInfo(name = "latest_price") val latestPrice: Double?,
    @ColumnInfo(name = "market_value") val marketValue: Double,
    @ColumnInfo(name = "floating_pnl") val floatingPnL: Double,
    @ColumnInfo(name = "historical_profit") val historicalProfit: Double,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
