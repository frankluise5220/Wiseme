package com.mmh.app.data.repository

import com.mmh.app.data.local.TokenProvider
import com.mmh.app.data.local.dao.AccountCacheDao
import com.mmh.app.data.local.entity.AccountCacheEntity
import com.mmh.app.data.remote.api.AccountApi
import com.mmh.app.data.remote.dto.AccountDto
import com.mmh.app.data.remote.dto.AccountGroupDto
import com.mmh.app.data.remote.dto.CreateAccountRequest
import com.mmh.app.data.remote.dto.ExternalAccountSummaryDto
import com.mmh.app.data.remote.dto.InvestmentAccountDto
import com.mmh.app.data.remote.dto.UpdateAccountRequest
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class AccountRepository @Inject constructor(
    private val accountApi: AccountApi,
    private val cacheDao: AccountCacheDao,
    private val tokenProvider: TokenProvider
) {

    suspend fun getAccounts(forceRefresh: Boolean = false): Resource<List<ExternalAccountSummaryDto>> {
        return try {
            if (!forceRefresh && tokenProvider.isConnected) {
                val cached = cacheDao.getActive()
                if (cached.isNotEmpty()) {
                    return Resource.Success(cached.map { it.toExternalSummary() })
                }
            }

            val response = accountApi.getExternalSummaries()
            val body = response.body()
            if (response.isSuccessful && body?.ok == true && body.accounts != null) {
                cacheDao.clearAll()
                cacheDao.upsertAll(body.accounts.map { it.toCacheEntity() })
                Resource.Success(body.accounts)
            } else {
                Resource.Error(body?.error ?: "获取账户列表失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch accounts")
            val cached = cacheDao.getActive()
            if (cached.isNotEmpty()) {
                Resource.Success(cached.map { it.toExternalSummary() })
            } else {
                Resource.Error(e.message ?: "网络错误")
            }
        }
    }

    suspend fun getCachedAccounts(): List<ExternalAccountSummaryDto> {
        return cacheDao.getActive().map { it.toExternalSummary() }
    }

    suspend fun getInvestmentAccounts(forceRefresh: Boolean = false): Resource<List<InvestmentAccountDto>> {
        return try {
            if (!forceRefresh && tokenProvider.isConnected) {
                val cached = cacheDao.getByKind("investment")
                if (cached.isNotEmpty()) {
                    return Resource.Success(cached.map { it.toInvestmentAccount() })
                }
            }

            val response = accountApi.getInvestmentAccounts()
            val body = response.body()
            if (response.isSuccessful && body?.ok == true) {
                val accounts = body.accounts ?: emptyList()
                if (accounts.isNotEmpty()) {
                    cacheDao.upsertAll(accounts.map { it.toCacheEntity() })
                }
                Resource.Success(accounts)
            } else {
                val cached = cacheDao.getByKind("investment")
                if (cached.isNotEmpty()) {
                    Resource.Success(cached.map { it.toInvestmentAccount() })
                } else {
                    Resource.Error(body?.error ?: "获取投资账户失败")
                }
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch investment accounts")
            val cached = cacheDao.getByKind("investment")
            if (cached.isNotEmpty()) {
                Resource.Success(cached.map { it.toInvestmentAccount() })
            } else {
                Resource.Error(e.message ?: "网络错误")
            }
        }
    }

    suspend fun getCachedInvestmentAccounts(): List<InvestmentAccountDto> {
        return cacheDao.getByKind("investment").map { it.toInvestmentAccount() }
    }

    suspend fun getAccountGroups(): Resource<List<AccountGroupDto>> {
        return try {
            val response = accountApi.getAccountGroups()
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.groups ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "获取分组失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch account groups")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun createAccount(request: CreateAccountRequest): Resource<AccountDto> {
        return try {
            val response = accountApi.createAccount(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("创建失败"))
            } else {
                Resource.Error(response.body()?.error ?: "创建失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to create account")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun updateAccount(request: UpdateAccountRequest): Resource<Unit> {
        return try {
            val response = accountApi.updateAccount(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(Unit)
            } else {
                Resource.Error(response.body()?.error ?: "更新失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to update account")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun deleteAccount(id: String, password: String? = null): Resource<Unit> {
        return try {
            val body = if (password != null) mapOf("password" to password) else null
            val response = accountApi.deleteAccount(id, body)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(Unit)
            } else {
                Resource.Error(response.body()?.error ?: "删除失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to delete account")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun refreshCache() {
        try {
            if (!tokenProvider.isConnected) return
            val response = accountApi.getExternalSummaries()
            val body = response.body()
            if (response.isSuccessful && body?.ok == true) {
                val accounts = body.accounts ?: return
                cacheDao.clearAll()
                cacheDao.upsertAll(accounts.map { it.toCacheEntity() })
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to refresh account cache")
        }
    }

    private fun ExternalAccountSummaryDto.toCacheEntity() = AccountCacheEntity(
        id = id.ifBlank { name },
        name = name,
        balance = balance,
        kind = kind,
        debtDirection = null,
        currency = currency,
        isActive = true,
        isPlaceholder = false,
        investProductType = null,
        tradingCalendar = null,
        creditLimit = null,
        billingDay = null,
        repaymentDay = null,
        numberMasked = null,
        groupId = "",
        groupName = groupName,
        institutionName = institutionName,
        institutionId = null,
        costBasisMethod = null,
        usageCount = usageCount,
        lastUsedAt = lastUsedAt
    )

    private fun InvestmentAccountDto.toCacheEntity() = AccountCacheEntity(
        id = id,
        name = name,
        balance = balance,
        kind = "investment",
        debtDirection = null,
        currency = currency,
        isActive = true,
        isPlaceholder = false,
        investProductType = investProductType,
        tradingCalendar = null,
        creditLimit = null,
        billingDay = null,
        repaymentDay = null,
        numberMasked = null,
        groupId = "",
        groupName = null,
        institutionName = institutionName,
        institutionId = null,
        costBasisMethod = null
    )

    private fun AccountCacheEntity.toExternalSummary() = ExternalAccountSummaryDto(
        id = id,
        name = name,
        balance = balance,
        count = 0,
        kind = kind,
        currency = currency,
        groupName = groupName,
        institutionName = institutionName,
        usageCount = usageCount,
        lastUsedAt = lastUsedAt
    )

    private fun AccountCacheEntity.toInvestmentAccount() = InvestmentAccountDto(
        id = id,
        name = name,
        balance = balance,
        investProductType = investProductType ?: "fund",
        currency = currency,
        institutionName = institutionName
    )
}
