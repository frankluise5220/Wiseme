package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Regular Investment Plan DTOs.
 * API: /api/v1/regular-invest (GET, POST, PUT, DELETE)
 */

@Serializable
data class RegularInvestPlanDto(
    val id: String = "",
    val householdId: String = "",
    val accountId: String = "",
    val accountName: String = "",
    val accountInstitutionName: String? = null,
    val cashAccountId: String? = null,
    val cashAccountName: String? = null,
    val cashAccountInstitutionName: String? = null,
    val fundCode: String = "",
    val fundName: String = "",
    val planName: String? = null,
    val fundProductType: String? = null,
    val amount: Double = 0.0,
    val intervalUnit: String = "month",
    val intervalValue: Int = 1,
    val executionDay: Int? = null,
    val startDate: String = "",
    val endDate: String? = null,
    val totalRuns: Int? = null,
    val executedRuns: Int = 0,
    val lastRunDate: String? = null,
    val nextRunDate: String = "",
    val status: String = "active",
    val feeRate: Double? = null,
    val confirmDays: Int? = null,
    val arrivalDays: Int? = null,
    val memo: String? = null,
    val skipPendingPreceding: Boolean = true,
    val createdAt: String = "",
    val updatedAt: String = ""
)

/** Request for creating a regular invest plan */
@Serializable
data class CreateRegularInvestRequest(
    val accountId: String,
    val cashAccountId: String? = null,
    val fundCode: String,
    val fundName: String = "",
    val planName: String? = null,
    val fundProductType: String? = null,
    val amount: Double,
    val intervalUnit: String = "month",
    val intervalValue: Int = 1,
    val startDate: String,
    val endDate: String? = null,
    val totalRuns: Int? = null,
    val executionDay: Int? = null,
    val feeRate: Double? = null,
    val confirmDays: Int? = null,
    val arrivalDays: Int? = null,
    val memo: String? = null,
    val skipPendingPreceding: Boolean = true
)

/** Request for updating a regular invest plan */
@Serializable
data class UpdateRegularInvestRequest(
    val id: String,
    val action: String? = null,  // "pause" | "resume" | "stop"
    val accountId: String? = null,
    val cashAccountId: String? = null,
    val fundName: String? = null,
    val planName: String? = null,
    val amount: Double? = null,
    val intervalUnit: String? = null,
    val intervalValue: Int? = null,
    val startDate: String? = null,
    val nextRunDate: String? = null,
    val endDate: String? = null,
    val totalRuns: Int? = null,
    val executionDay: Int? = null,
    val feeRate: Double? = null,
    val confirmDays: Int? = null,
    val arrivalDays: Int? = null,
    val memo: String? = null,
    val skipPendingPreceding: Boolean? = null
)

/** Regular invest plan list response */
@Serializable
data class RegularInvestListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val plans: List<RegularInvestPlanDto> = emptyList()
)

/** Regular invest plan single response */
@Serializable
data class RegularInvestSingleResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null,
    val plan: RegularInvestPlanDto? = null,
    val deletedEntries: Boolean? = null,
    val reset: Boolean? = null
)
