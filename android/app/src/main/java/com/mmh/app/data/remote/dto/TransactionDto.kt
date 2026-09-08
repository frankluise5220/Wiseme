package com.mmh.app.data.remote.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Transaction (TxRecord) model.
 * API: GET /api/v1/transactions/detail?accountId=...&page=...&pageSize=...
 */
@Serializable
data class TransactionDto(
    val id: String = "",
    val date: String = "",
    val postedAt: String? = null,
    val amount: Double = 0.0,
    val type: String = "expense",
    val dayOrder: Int = 0,
    val categoryId: String? = null,
    val categoryName: String = "",
    val accountId: String = "",
    val accountName: String = "",
    val accountKind: String? = null,
    val accountInstitutionName: String? = null,
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val toAccountKind: String? = null,
    val toAccountInstitutionName: String? = null,
    val note: String? = null,
    val fundSubtype: String? = null,
    val fundCode: String? = null,
    val fundName: String? = null,
    val fundProductType: String? = null,
    val fundNav: Double? = null,
    val fundUnits: Double? = null,
    val fundFee: Double? = null,
    val fundConfirmDate: String? = null,
    val fundArrivalDate: String? = null,
    val fundArrivalAmount: Double? = null,
    val creditCardInstallmentPlanId: String? = null,
    val installmentNo: Int? = null,
    val installmentTotal: Int? = null,
    val installmentPrincipal: Double? = null,
    val installmentInterest: Double? = null,
    val installmentRole: String? = null,
    val source: String? = null,
    val entryTags: List<EntryTagDto> = emptyList()
)

@Serializable
data class EntryTagDto(
    val tagId: String = "",
    val Tag: TagInfoDto? = null
)

@Serializable
data class TagInfoDto(
    val name: String = "",
    val color: String? = null
)

/** Transfer item from external API GET /api/v1/transactions */
@Serializable
data class TransactionItemDto(
    val id: String = "",
    val transactionId: String = "",
    val date: String = "",
    val type: String = "expense",
    val amount: Double = 0.0,
    val accountId: String = "",
    val accountName: String = "",
    val accountInstitutionName: String? = null,
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val toAccountInstitutionName: String? = null,
    val categoryName: String = "",
    val note: String? = null,
    val creditCardInstallmentPlanId: String? = null,
    val installmentNo: Int? = null,
    val installmentTotal: Int? = null,
    val installmentPrincipal: Double? = null,
    val installmentInterest: Double? = null,
    val installmentRole: String? = null,
    val counterparty: String? = null,
    val sourceText: String? = null
)

/** Request body for creating a transaction */
@Serializable
data class CreateTransactionRequest(
    val date: String,
    val amount: Double,
    val type: String,
    val accountId: String,
    val categoryId: String? = null,
    val categoryName: String? = null,
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val note: String? = null,
    val fundCode: String? = null,
    val fundName: String? = null,
    val fundProductType: String? = null,
    val fundSubtype: String? = null,
    val fundNav: Double? = null,
    val fundUnits: Double? = null,
    val fundFee: Double? = null,
    val fundConfirmDate: String? = null,
    val fundArrivalDate: String? = null,
    val fundArrivalAmount: Double? = null,
    val cashAccountId: String? = null,
    val source: String? = null,
    val tagIds: List<String>? = null
)

/** Request body for updating a transaction */
@Serializable
data class UpdateTransactionRequest(
    val id: String,
    val date: String? = null,
    val amount: Double? = null,
    val type: String? = null,
    val accountId: String? = null,
    val categoryId: String? = null,
    val categoryName: String? = null,
    val toAccountId: String? = null,
    val toAccountName: String? = null,
    val note: String? = null,
    val fundCode: String? = null,
    val fundName: String? = null,
    val fundProductType: String? = null,
    val fundSubtype: String? = null,
    val fundNav: Double? = null,
    val fundUnits: Double? = null,
    val fundFee: Double? = null,
    val fundConfirmDate: String? = null,
    val fundArrivalDate: String? = null,
    val fundArrivalAmount: Double? = null,
    val cashAccountId: String? = null,
    val keepFundDetail: Boolean? = null,
    val tagIds: List<String>? = null
)

/** Category entity from API */
@Serializable
data class CategoryItemDto(
    val id: String = "",
    val name: String = "",
    val type: String = "expense",
    val parentId: String? = null
)

/** Category list response */
@Serializable
data class CategoryListResponseDto(
    val ok: Boolean = false,
    val error: String? = null,
    val categories: List<CategoryItemDto>? = null
)
