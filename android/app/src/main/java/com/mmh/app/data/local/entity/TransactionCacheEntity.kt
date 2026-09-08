package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Local cache for transaction records of a specific account page.
 * Keyed by accountId + page for cache invalidation.
 */
@Entity(tableName = "transaction_cache")
data class TransactionCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    val date: String,
    @ColumnInfo(name = "posted_at") val postedAt: String? = null,
    val amount: Double,
    val type: String,
    @ColumnInfo(name = "day_order") val dayOrder: Int = 0,
    @ColumnInfo(name = "category_name") val categoryName: String?,
    @ColumnInfo(name = "account_name") val accountName: String,
    @ColumnInfo(name = "account_kind") val accountKind: String? = null,
    @ColumnInfo(name = "account_institution_name") val accountInstitutionName: String? = null,
    @ColumnInfo(name = "to_account_id") val toAccountId: String?,
    @ColumnInfo(name = "to_account_name") val toAccountName: String?,
    @ColumnInfo(name = "to_account_kind") val toAccountKind: String? = null,
    @ColumnInfo(name = "to_account_institution_name") val toAccountInstitutionName: String? = null,
    val note: String?,
    @ColumnInfo(name = "fund_code") val fundCode: String?,
    @ColumnInfo(name = "fund_name") val fundName: String?,
    @ColumnInfo(name = "fund_subtype") val fundSubtype: String?,
    @ColumnInfo(name = "fund_nav") val fundNav: Double? = null,
    @ColumnInfo(name = "fund_units") val fundUnits: Double? = null,
    @ColumnInfo(name = "fund_fee") val fundFee: Double? = null,
    @ColumnInfo(name = "fund_confirm_date") val fundConfirmDate: String? = null,
    @ColumnInfo(name = "fund_arrival_date") val fundArrivalDate: String? = null,
    @ColumnInfo(name = "fund_arrival_amount") val fundArrivalAmount: Double? = null,
    @ColumnInfo(name = "page") val page: Int = 1,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
