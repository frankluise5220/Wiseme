package com.mmh.app.data.remote.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class AccountDto(
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
    val householdId: String = "",
    val institutionId: String? = null,
    val groupId: String = "",
    val costBasisMethod: String? = null,
    val defaultConfirmDays: Int? = null,
    val defaultArrivalDays: Int? = null,
    @SerialName("AccountGroup")
    val accountGroup: AccountGroupDto? = null,
    @SerialName("Institution")
    val institution: InstitutionDto? = null
)

@Serializable
data class AccountGroupDto(
    val id: String = "",
    val name: String = "",
    val sortOrder: Int = 0
)

@Serializable
data class InstitutionDto(
    val id: String = "",
    val name: String = "",
    val type: String = "bank"
)

@Serializable
data class AccountBalanceDto(
    val id: String = "",
    val balance: Double = 0.0,
    val kind: String = "other"
)

@Serializable
data class ExternalAccountSummaryDto(
    val id: String = "",
    val name: String = "",
    val balance: Double = 0.0,
    val count: Int = 0,
    val kind: String = "other",
    val currency: String = "CNY",
    val groupName: String? = null,
    val institutionName: String? = null,
    val usageCount: Int = 0,
    val lastUsedAt: String? = null
)

@Serializable
data class InvestmentAccountDto(
    val id: String = "",
    val name: String = "",
    val balance: Double = 0.0,
    val investProductType: String = "fund",
    val currency: String = "CNY",
    val institutionName: String? = null
)

@Serializable
data class ExternalAccountListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val accounts: List<ExternalAccountSummaryDto>? = null
)

@Serializable
data class InvestmentAccountListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val accounts: List<InvestmentAccountDto>? = null
)

@Serializable
data class CreateAccountRequest(
    val name: String,
    val kind: String = "other",
    val groupId: String? = null,
    val institutionId: String? = null,
    val currency: String = "CNY",
    val investProductType: String? = null,
    val costBasisMethod: String? = null,
    val defaultFundQueryApiId: String? = null,
    val billingDay: Int? = null,
    val repaymentDay: Int? = null,
    val creditLimit: Double? = null,
    val numberMasked: String? = null
)

@Serializable
data class UpdateAccountRequest(
    val id: String,
    val name: String? = null,
    val kind: String? = null,
    val currency: String? = null,
    val groupId: String? = null,
    val institutionId: String? = null,
    val investProductType: String? = null,
    val costBasisMethod: String? = null,
    val defaultFundQueryApiId: String? = null,
    val billingDay: Int? = null,
    val repaymentDay: Int? = null,
    val creditLimit: Double? = null,
    val numberMasked: String? = null
)
