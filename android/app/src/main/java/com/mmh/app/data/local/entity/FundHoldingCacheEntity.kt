package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "fund_holding_cache")
data class FundHoldingCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "fund_code") val fundCode: String,
    @ColumnInfo(name = "fund_name") val fundName: String?,
    val units: Double,
    @ColumnInfo(name = "avg_cost") val avgCost: Double,
    val cost: Double,
    val nav: Double?,
    @ColumnInfo(name = "nav_date") val navDate: String?,
    @ColumnInfo(name = "pending_cost") val pendingCost: Double,
    @ColumnInfo(name = "historical_profit") val historicalProfit: Double,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
