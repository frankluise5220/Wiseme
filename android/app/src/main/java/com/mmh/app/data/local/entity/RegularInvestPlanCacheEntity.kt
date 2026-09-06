package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "regular_invest_plan_cache")
data class RegularInvestPlanCacheEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "household_id") val householdId: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "account_name") val accountName: String,
    @ColumnInfo(name = "account_institution_name") val accountInstitutionName: String?,
    @ColumnInfo(name = "cash_account_id") val cashAccountId: String?,
    @ColumnInfo(name = "cash_account_name") val cashAccountName: String?,
    @ColumnInfo(name = "cash_account_institution_name") val cashAccountInstitutionName: String?,
    @ColumnInfo(name = "fund_code") val fundCode: String,
    @ColumnInfo(name = "fund_name") val fundName: String,
    @ColumnInfo(name = "plan_name") val planName: String?,
    @ColumnInfo(name = "fund_product_type") val fundProductType: String?,
    val amount: Double,
    @ColumnInfo(name = "interval_unit") val intervalUnit: String,
    @ColumnInfo(name = "interval_value") val intervalValue: Int,
    @ColumnInfo(name = "execution_day") val executionDay: Int?,
    @ColumnInfo(name = "start_date") val startDate: String,
    @ColumnInfo(name = "end_date") val endDate: String?,
    @ColumnInfo(name = "total_runs") val totalRuns: Int?,
    @ColumnInfo(name = "executed_runs") val executedRuns: Int,
    @ColumnInfo(name = "last_run_date") val lastRunDate: String?,
    @ColumnInfo(name = "next_run_date") val nextRunDate: String,
    val status: String,
    @ColumnInfo(name = "fee_rate") val feeRate: Double?,
    @ColumnInfo(name = "confirm_days") val confirmDays: Int?,
    @ColumnInfo(name = "arrival_days") val arrivalDays: Int?,
    val memo: String?,
    @ColumnInfo(name = "skip_pending_preceding") val skipPendingPreceding: Boolean,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "cached_at") val cachedAt: Long = System.currentTimeMillis()
)
