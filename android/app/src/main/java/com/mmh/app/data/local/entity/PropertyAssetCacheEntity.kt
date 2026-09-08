package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local cache for property assets synced from GET /api/v1/mobile/sync.
 */
@Entity(tableName = "property_asset_cache")
data class PropertyAssetCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    val name: String,
    @ColumnInfo(name = "property_type") val propertyType: String?,
    val address: String?,
    val currency: String,
    @ColumnInfo(name = "purchase_date") val purchaseDate: String?,
    @ColumnInfo(name = "purchase_price") val purchasePrice: Double?,
    val cost: Double,
    @ColumnInfo(name = "market_value") val marketValue: Double,
    @ColumnInfo(name = "latest_valuation_date") val latestValuationDate: String?,
    val status: String?,
    val note: String?,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
