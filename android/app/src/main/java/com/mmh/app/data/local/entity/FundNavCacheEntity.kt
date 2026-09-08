package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "fund_nav_cache")
data class FundNavCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "fund_code") val fundCode: String,
    @ColumnInfo(name = "nav_date") val navDate: String,
    val nav: Double,
    @ColumnInfo(name = "cum_nav") val cumNav: Double?,
    val name: String?,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
