package com.mmh.app.data.repository

import com.mmh.app.data.local.TokenProvider
import com.mmh.app.data.local.dao.AccountCacheDao
import com.mmh.app.data.local.dao.CategoryCacheDao
import com.mmh.app.data.local.dao.FundHoldingCacheDao
import com.mmh.app.data.local.dao.FundNavCacheDao
import com.mmh.app.data.local.dao.PropertyAssetCacheDao
import com.mmh.app.data.local.dao.RegularInvestPlanCacheDao
import com.mmh.app.data.local.dao.StockHoldingCacheDao
import com.mmh.app.data.local.dao.SyncStateDao
import com.mmh.app.data.local.dao.TransactionCacheDao
import com.mmh.app.data.local.entity.AccountCacheEntity
import com.mmh.app.data.local.entity.CategoryCacheEntity
import com.mmh.app.data.local.entity.FundHoldingCacheEntity
import com.mmh.app.data.local.entity.FundNavCacheEntity
import com.mmh.app.data.local.entity.PropertyAssetCacheEntity
import com.mmh.app.data.local.entity.RegularInvestPlanCacheEntity
import com.mmh.app.data.local.entity.StockHoldingCacheEntity
import com.mmh.app.data.local.entity.SyncStateEntity
import com.mmh.app.data.local.entity.TransactionCacheEntity
import com.mmh.app.data.remote.api.MobileSyncApi
import com.mmh.app.data.remote.dto.CategoryItemDto
import com.mmh.app.data.remote.dto.MobileSyncAccountDto
import com.mmh.app.data.remote.dto.MobileSyncFundHoldingDto
import com.mmh.app.data.remote.dto.MobileSyncFundNavDto
import com.mmh.app.data.remote.dto.MobileSyncPropertyAssetDto
import com.mmh.app.data.remote.dto.MobileSyncStockHoldingDto
import com.mmh.app.data.remote.dto.RegularInvestPlanDto
import com.mmh.app.data.remote.dto.TransactionDto
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

data class MobileSyncSummary(
    val accountCount: Int = 0,
    val categoryCount: Int = 0,
    val transactionCount: Int = 0,
    val deletedTransactionCount: Int = 0,
    val fundHoldingCount: Int = 0,
    val fundNavCount: Int = 0,
    val regularInvestPlanCount: Int = 0,
    val stockHoldingCount: Int = 0,
    val propertyAssetCount: Int = 0,
    val serverTime: String = ""
)

@Singleton
class MobileSyncRepository @Inject constructor(
    private val mobileSyncApi: MobileSyncApi,
    private val accountCacheDao: AccountCacheDao,
    private val categoryCacheDao: CategoryCacheDao,
    private val fundHoldingCacheDao: FundHoldingCacheDao,
    private val fundNavCacheDao: FundNavCacheDao,
    private val propertyAssetCacheDao: PropertyAssetCacheDao,
    private val regularInvestPlanCacheDao: RegularInvestPlanCacheDao,
    private val stockHoldingCacheDao: StockHoldingCacheDao,
    private val transactionCacheDao: TransactionCacheDao,
    private val syncStateDao: SyncStateDao,
    private val tokenProvider: TokenProvider
) {

    suspend fun syncOnce(forceFull: Boolean = false, refreshDaily: Boolean = false): Resource<MobileSyncSummary> {
        if (!tokenProvider.isConnected) {
            return Resource.Success(MobileSyncSummary())
        }

        val key = syncKey()
        val previousCursor = if (forceFull) null else syncStateDao.get(key)?.lastSyncAt

        return try {
            val response = mobileSyncApi.sync(
                since = previousCursor,
                refreshDaily = if (refreshDaily) 1 else null
            )
            val body = response.body()
            if (!response.isSuccessful || body?.ok != true) {
                return Resource.Error(body?.error ?: "Mobile sync failed")
            }

            val fullSnapshot = previousCursor == null || forceFull
            if (fullSnapshot) {
                accountCacheDao.clearAll()
                categoryCacheDao.clearAll()
                fundHoldingCacheDao.clearAll()
                fundNavCacheDao.clearAll()
                regularInvestPlanCacheDao.clearAll()
                stockHoldingCacheDao.clearAll()
                propertyAssetCacheDao.clearAll()
                transactionCacheDao.clearAll()
            }

            if (body.accounts.isNotEmpty()) {
                accountCacheDao.upsertAll(body.accounts.map { it.toCacheEntity() })
            }

            // Category has no server-side updatedAt yet, so mobile sync returns it as a table snapshot.
            categoryCacheDao.clearAll()
            if (body.categories.isNotEmpty()) {
                categoryCacheDao.upsertAll(body.categories.map { it.toCacheEntity() })
            }

            if (body.deletedTransactionIds.isNotEmpty()) {
                transactionCacheDao.deleteByIds(body.deletedTransactionIds)
            }
            if (body.transactions.isNotEmpty()) {
                transactionCacheDao.upsertAll(body.transactions.map { it.toCacheEntity() })
                upsertTransactionNavCache(body.transactions)
            }
            if (body.fundHoldings.isNotEmpty()) {
                fundHoldingCacheDao.upsertAll(body.fundHoldings.map { it.toCacheEntity() })
            }
            if (body.fundNav.isNotEmpty()) {
                fundNavCacheDao.upsertAll(body.fundNav.map { it.toCacheEntity() })
            }
            if (body.regularInvestPlans.isNotEmpty()) {
                regularInvestPlanCacheDao.upsertAll(body.regularInvestPlans.map { it.toCacheEntity() })
            }
            if (body.stockHoldings.isNotEmpty()) {
                stockHoldingCacheDao.upsertAll(body.stockHoldings.map { it.toCacheEntity() })
            }
            if (body.propertyAssets.isNotEmpty()) {
                propertyAssetCacheDao.upsertAll(body.propertyAssets.map { it.toCacheEntity() })
            }

            if (!body.hasMore && body.serverTime.isNotBlank()) {
                syncStateDao.upsert(SyncStateEntity(key = key, lastSyncAt = body.serverTime))
                if (refreshDaily) {
                    syncStateDao.upsert(SyncStateEntity(key = dailySyncKey(), lastSyncAt = body.serverTime))
                }
            }

            Resource.Success(
                MobileSyncSummary(
                    accountCount = body.accounts.size,
                    categoryCount = body.categories.size,
                    transactionCount = body.transactions.size,
                    deletedTransactionCount = body.deletedTransactionIds.size,
                    fundHoldingCount = body.fundHoldings.size,
                    fundNavCount = body.fundNav.size,
                    regularInvestPlanCount = body.regularInvestPlans.size,
                    stockHoldingCount = body.stockHoldings.size,
                    propertyAssetCount = body.propertyAssets.size,
                    serverTime = body.serverTime
                )
            )
        } catch (e: Exception) {
            Timber.e(e, "Mobile sync failed")
            Resource.Error(e.message ?: "Mobile sync failed")
        }
    }

    suspend fun syncDailyIfNeeded(): Resource<MobileSyncSummary> {
        val lastDailyServerDate = syncStateDao.get(dailySyncKey())?.lastSyncAt?.substringBefore("T").orEmpty()
        val today = java.time.LocalDate.now().toString()
        val hasHoldingWithoutNavCache = fundHoldingCacheDao.countHoldingsWithoutNavCache() > 0
        if (lastDailyServerDate == today && !hasHoldingWithoutNavCache) {
            return Resource.Success(MobileSyncSummary())
        }
        return syncOnce(refreshDaily = true)
    }

    private fun syncKey(): String {
        val serverId = tokenProvider.getActiveServerId().ifBlank { tokenProvider.getServerUrl() }
        val householdId = tokenProvider.getHouseholdId().ifBlank { "default" }
        return "$serverId:$householdId"
    }

    private fun dailySyncKey(): String = "${syncKey()}:daily-fund-nav"

    private fun MobileSyncAccountDto.toCacheEntity() = AccountCacheEntity(
        id = id,
        name = name,
        balance = balance,
        kind = kind,
        debtDirection = debtDirection,
        currency = currency,
        isActive = isActive,
        isPlaceholder = isPlaceholder,
        investProductType = investProductType,
        tradingCalendar = tradingCalendar,
        creditLimit = creditLimit,
        billingDay = billingDay,
        repaymentDay = repaymentDay,
        numberMasked = numberMasked,
        institutionId = institutionId,
        groupId = groupId,
        groupName = groupName,
        institutionName = institutionName,
        costBasisMethod = costBasisMethod
    )

    private fun CategoryItemDto.toCacheEntity() = CategoryCacheEntity(
        id = id,
        name = name,
        type = type,
        parentId = parentId
    )

    private fun TransactionDto.toCacheEntity() = TransactionCacheEntity(
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
        page = 1
    )

    private fun MobileSyncFundHoldingDto.toCacheEntity() = FundHoldingCacheEntity(
        id = id,
        accountId = accountId,
        fundCode = fundCode,
        fundName = fundName,
        units = units,
        avgCost = avgCost,
        cost = cost,
        nav = nav,
        navDate = navDate,
        pendingCost = pendingCost,
        historicalProfit = historicalProfit,
        updatedAt = updatedAt
    )

    private fun MobileSyncFundNavDto.toCacheEntity() = FundNavCacheEntity(
        id = id,
        fundCode = fundCode,
        navDate = navDate,
        nav = nav,
        cumNav = cumNav,
        name = name,
        updatedAt = updatedAt
    )

    private suspend fun upsertTransactionNavCache(transactions: List<TransactionDto>) {
        val navItems = transactions.mapNotNull { tx ->
            val fundCode = tx.fundCode?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val navDate = tx.fundConfirmDate?.takeIf { it.isNotBlank() } ?: tx.date.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val nav = tx.fundNav?.takeIf { it > 0 } ?: return@mapNotNull null
            val date = navDate.substringBefore("T")
            FundNavCacheEntity(
                id = "$fundCode:$date",
                fundCode = fundCode,
                navDate = date,
                nav = nav,
                cumNav = null,
                name = tx.fundName,
                updatedAt = tx.date.substringBefore("T").ifBlank { date }
            )
        }
        if (navItems.isNotEmpty()) {
            fundNavCacheDao.upsertAll(navItems)
        }
    }

    private fun RegularInvestPlanDto.toCacheEntity() = RegularInvestPlanCacheEntity(
        id = id,
        householdId = householdId,
        accountId = accountId,
        accountName = accountName,
        accountInstitutionName = accountInstitutionName,
        cashAccountId = cashAccountId,
        cashAccountName = cashAccountName,
        cashAccountInstitutionName = cashAccountInstitutionName,
        fundCode = fundCode,
        fundName = fundName,
        planName = planName,
        fundProductType = fundProductType,
        amount = amount,
        intervalUnit = intervalUnit,
        intervalValue = intervalValue,
        executionDay = executionDay,
        startDate = startDate,
        endDate = endDate,
        totalRuns = totalRuns,
        executedRuns = executedRuns,
        lastRunDate = lastRunDate,
        nextRunDate = nextRunDate,
        status = status,
        feeRate = feeRate,
        confirmDays = confirmDays,
        arrivalDays = arrivalDays,
        memo = memo,
        skipPendingPreceding = skipPendingPreceding,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun MobileSyncStockHoldingDto.toCacheEntity() = StockHoldingCacheEntity(
        id = id,
        accountId = accountId,
        securityId = securityId,
        market = market,
        stockCode = stockCode,
        stockName = stockName,
        quantity = quantity,
        avgCost = avgCost,
        cost = cost,
        latestPrice = latestPrice,
        marketValue = marketValue,
        floatingPnL = floatingPnL,
        historicalProfit = historicalProfit,
        updatedAt = updatedAt
    )

    private fun MobileSyncPropertyAssetDto.toCacheEntity() = PropertyAssetCacheEntity(
        id = id,
        accountId = accountId,
        name = name,
        propertyType = propertyType,
        address = address,
        currency = currency,
        purchaseDate = purchaseDate,
        purchasePrice = purchasePrice,
        cost = cost,
        marketValue = marketValue,
        latestValuationDate = latestValuationDate,
        status = status,
        note = note,
        updatedAt = updatedAt
    )
}
