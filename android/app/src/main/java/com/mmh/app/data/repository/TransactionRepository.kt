package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.TransactionCacheDao
import com.mmh.app.data.local.entity.TransactionCacheEntity
import com.mmh.app.data.remote.api.TransactionApi
import com.mmh.app.data.remote.dto.CreateTransactionRequest
import com.mmh.app.data.remote.dto.PaginatedData
import com.mmh.app.data.remote.dto.TransactionDto
import com.mmh.app.data.remote.dto.TransactionItemDto
import com.mmh.app.data.remote.dto.UpdateTransactionRequest
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Repository for Transaction operations.
 * Local cache is used as the first read layer for Android screens.
 */
@Singleton
class TransactionRepository @Inject constructor(
    private val transactionApi: TransactionApi,
    private val transactionCacheDao: TransactionCacheDao
) {

    suspend fun getExternalTransactions(
        accountName: String? = null,
        limit: Int = 200
    ): Resource<List<TransactionItemDto>> {
        return try {
            if (accountName.isNullOrBlank()) {
                val cached = transactionCacheDao.getRecent(limit)
                if (cached.isNotEmpty()) {
                    return Resource.Success(cached.map { it.toListItem() })
                }
            }

            val response = transactionApi.getExternalTransactions(accountName, limit)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.items ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "Failed to fetch transactions")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch external transactions")
            val cached = transactionCacheDao.getRecent(limit)
            if (accountName.isNullOrBlank() && cached.isNotEmpty()) {
                Resource.Success(cached.map { it.toListItem() })
            } else {
                Resource.Error(e.message ?: "Network error")
            }
        }
    }

    suspend fun getTransactionById(id: String): Resource<TransactionDto> {
        return try {
            val response = transactionApi.getTransactionById(id)
            if (response.isSuccessful && response.body()?.ok == true) {
                val data = response.body()?.data ?: return Resource.Error("Transaction not found")
                Resource.Success(data)
            } else {
                Resource.Error(response.body()?.error ?: "Failed to fetch transaction")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch transaction by id")
            Resource.Error(e.message ?: "Network error")
        }
    }

    suspend fun getTransactionDetail(
        accountId: String,
        page: Int = 1,
        pageSize: Int = 20
    ): Resource<PaginatedData<TransactionDto>> {
        return try {
            val cached = transactionCacheDao.getByAccountAndPage(accountId, page)
            if (cached.isNotEmpty()) {
                return Resource.Success(cached.toPaginatedData(accountId, page, pageSize))
            }

            val response = transactionApi.getTransactionDetail(accountId, page, pageSize)
            if (response.isSuccessful && response.body()?.ok == true) {
                val data = response.body()?.data ?: PaginatedData()
                if (data.entries.isNotEmpty()) {
                    transactionCacheDao.upsertAll(data.entries.map { it.toCacheEntity(page) })
                }
                Resource.Success(data)
            } else {
                Resource.Error(response.body()?.error ?: "Failed to fetch transactions")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch transaction detail")
            val cached = transactionCacheDao.getByAccountAndPage(accountId, page)
            if (cached.isNotEmpty()) {
                Resource.Success(cached.toPaginatedData(accountId, page, pageSize))
            } else {
                Resource.Error(e.message ?: "Network error")
            }
        }
    }

    suspend fun createTransaction(request: CreateTransactionRequest): Resource<TransactionDto> {
        return try {
            val response = transactionApi.createTransaction(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                val data = response.body()?.data ?: return Resource.Error("Create failed")
                transactionCacheDao.upsertAll(listOf(data.toCacheEntity()))
                Resource.Success(data)
            } else {
                Resource.Error(response.body()?.error ?: "Create failed")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to create transaction")
            Resource.Error(e.message ?: "Network error")
        }
    }

    suspend fun updateTransaction(request: UpdateTransactionRequest): Resource<TransactionDto> {
        return try {
            val response = transactionApi.updateTransaction(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                val data = response.body()?.data ?: return Resource.Error("Update failed")
                transactionCacheDao.upsertAll(listOf(data.toCacheEntity()))
                Resource.Success(data)
            } else {
                Resource.Error(response.body()?.error ?: "Update failed")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to update transaction")
            Resource.Error(e.message ?: "Network error")
        }
    }

    suspend fun deleteTransaction(id: String): Resource<Unit> {
        return try {
            val response = transactionApi.deleteTransaction(id)
            if (response.isSuccessful && response.body()?.ok == true) {
                transactionCacheDao.deleteByIds(listOf(id))
                Resource.Success(Unit)
            } else {
                Resource.Error(response.body()?.error ?: "Delete failed")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to delete transaction")
            Resource.Error(e.message ?: "Network error")
        }
    }

    suspend fun getCachedFundTransactions(accountId: String, fundCode: String): List<TransactionDto> {
        if (accountId.isBlank() || fundCode.isBlank()) return emptyList()
        return transactionCacheDao.getFundEntries(accountId, fundCode).map { it.toDto() }
    }

    private fun List<TransactionCacheEntity>.toPaginatedData(
        accountId: String,
        page: Int,
        pageSize: Int
    ) = PaginatedData(
        entries = take(pageSize).map { it.toDto() },
        totalCount = size,
        page = page,
        pageSize = pageSize,
        accountId = accountId
    )

    private fun TransactionDto.toCacheEntity(page: Int = 1) = TransactionCacheEntity(
        id = id,
        accountId = accountId,
        date = date,
        postedAt = postedAt,
        amount = amount,
        type = type,
        dayOrder = dayOrder,
        categoryName = categoryName,
        accountName = accountName,
        accountKind = accountKind,
        accountInstitutionName = accountInstitutionName,
        toAccountId = toAccountId,
        toAccountName = toAccountName,
        toAccountKind = toAccountKind,
        toAccountInstitutionName = toAccountInstitutionName,
        note = note,
        fundCode = fundCode,
        fundName = fundName,
        fundSubtype = fundSubtype,
        fundNav = fundNav,
        fundUnits = fundUnits,
        fundFee = fundFee,
        fundConfirmDate = fundConfirmDate,
        fundArrivalDate = fundArrivalDate,
        fundArrivalAmount = fundArrivalAmount,
        page = page
    )

    private fun TransactionCacheEntity.toDto() = TransactionDto(
        id = id,
        date = date,
        postedAt = postedAt,
        amount = amount,
        type = type,
        dayOrder = dayOrder,
        categoryName = categoryName.orEmpty(),
        accountId = accountId,
        accountName = accountName,
        accountKind = accountKind,
        accountInstitutionName = accountInstitutionName,
        toAccountId = toAccountId,
        toAccountName = toAccountName,
        toAccountKind = toAccountKind,
        toAccountInstitutionName = toAccountInstitutionName,
        note = note,
        fundCode = fundCode,
        fundName = fundName,
        fundSubtype = fundSubtype,
        fundNav = fundNav,
        fundUnits = fundUnits,
        fundFee = fundFee,
        fundConfirmDate = fundConfirmDate,
        fundArrivalDate = fundArrivalDate,
        fundArrivalAmount = fundArrivalAmount
    )

    private fun TransactionCacheEntity.toListItem() = TransactionItemDto(
        id = id,
        transactionId = id,
        date = date,
        amount = amount,
        type = type,
        accountId = accountId,
        accountName = accountName,
        accountInstitutionName = accountInstitutionName,
        toAccountId = toAccountId,
        toAccountName = toAccountName,
        toAccountInstitutionName = toAccountInstitutionName,
        categoryName = categoryName.orEmpty(),
        note = note
    )
}
