package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local cache for account list.
 * Cached after initial load to avoid refetching on every screen open.
 */
@Entity(tableName = "account_cache")
data class AccountCacheEntity(
    @PrimaryKey val id: String,
    val name: String,
    val balance: Double,
    val kind: String,
    val debtDirection: String?,
    val currency: String,
    val isActive: Boolean,
    val isPlaceholder: Boolean,
    val investProductType: String?,
    val tradingCalendar: String?,
    val creditLimit: Double?,
    val billingDay: Int?,
    val repaymentDay: Int?,
    val numberMasked: String?,
    val institutionId: String?,
    val groupId: String,
    val groupName: String?,
    val institutionName: String?,
    val costBasisMethod: String?,
    val usageCount: Int = 0,
    val lastUsedAt: String? = null,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
