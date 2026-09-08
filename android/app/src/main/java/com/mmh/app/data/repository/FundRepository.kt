package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.FundHoldingCacheDao
import com.mmh.app.data.local.dao.FundNavCacheDao
import com.mmh.app.data.local.dao.TransactionCacheDao
import com.mmh.app.data.local.entity.FundHoldingCacheEntity
import com.mmh.app.data.local.entity.FundNavCacheEntity
import com.mmh.app.data.local.entity.TransactionCacheEntity
import com.mmh.app.data.remote.api.FundApi
import com.mmh.app.data.remote.api.InvestApi
import com.mmh.app.data.remote.dto.FundDayPnlDto
import com.mmh.app.data.remote.dto.FundEntryDto
import com.mmh.app.data.remote.dto.FundMonthPnlDto
import com.mmh.app.data.remote.dto.FundPositionDto
import com.mmh.app.data.remote.dto.FundShellDataResponse
import com.mmh.app.data.remote.dto.NavRecordDto
import com.mmh.app.data.remote.dto.NavHistoryItem
import com.mmh.app.data.remote.dto.PreloadNavRequest
import com.mmh.app.domain.model.Resource
import com.mmh.app.data.remote.dto.SetFundConfirmDaysRequest
import com.mmh.app.data.remote.dto.SetFundFeeRateRequest
import timber.log.Timber
import java.time.LocalDate
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FundRepository @Inject constructor(
    private val fundApi: FundApi,
    private val investApi: InvestApi,
    private val fundHoldingCacheDao: FundHoldingCacheDao,
    private val fundNavCacheDao: FundNavCacheDao,
    private val transactionCacheDao: TransactionCacheDao
) {

    suspend fun getCachedHoldings(accountId: String? = null): List<FundPositionDto> {
        val items = if (accountId.isNullOrBlank()) {
            fundHoldingCacheDao.getAll()
        } else {
            fundHoldingCacheDao.getByAccount(accountId)
        }
        val latestNavByCode = fundNavCacheDao.getLatestAll().associateBy { it.fundCode }
        return items.map { it.toPositionDto(latestNavByCode[it.fundCode]) }
    }

    suspend fun getCachedHolding(accountId: String, fundCode: String): FundPositionDto? {
        val latestNav = fundNavCacheDao.getLatestByFundCode(fundCode)
        return fundHoldingCacheDao.getByAccountAndCode(accountId, fundCode)?.toPositionDto(latestNav)
    }

    suspend fun getCachedFundEntries(accountId: String, fundCode: String): List<FundEntryDto> {
        val entries = transactionCacheDao.getFundEntries(accountId, fundCode).map { it.toFundEntryDto() }
        upsertEntryNavCache(fundCode, entries)
        return entries
    }

    suspend fun getCachedNavHistory(fundCode: String): List<NavHistoryItem> {
        return fundNavCacheDao.getByFundCode(fundCode).map { it.toNavHistoryItem() }
    }

    suspend fun syncNavHistoryToCache(
        fundCode: String,
        startDate: String?,
        endDate: String = LocalDate.now().toString()
    ): Resource<List<NavHistoryItem>> {
        if (fundCode.isBlank()) return Resource.Error("缺少基金代码")
        val start = startDate?.takeIf { it.isNotBlank() } ?: LocalDate.now().minusYears(1).toString()

        return try {
            val firstResponse = fundApi.getNavHistory(fundCode, start, endDate)
            var history = if (firstResponse.isSuccessful && firstResponse.body()?.ok == true) {
                firstResponse.body()?.data.orEmpty()
            } else {
                emptyList()
            }

            val requestedStart = LocalDate.parse(start)
            val earliestHistoryDate = history.mapNotNull { it.date.toLocalDateOrNull() }.minOrNull()
            val needsPreload = history.size < 2 || earliestHistoryDate == null || earliestHistoryDate.isAfter(requestedStart.plusDays(7))

            if (needsPreload) {
                val preloadResponse = fundApi.preloadNavHistory(
                    PreloadNavRequest(
                        fundCode = fundCode,
                        startDate = start,
                        endDate = endDate
                    )
                )
                if (!preloadResponse.isSuccessful || preloadResponse.body()?.ok != true) {
                    return Resource.Error(preloadResponse.body()?.error ?: "历史净值补齐失败")
                }

                val secondResponse = fundApi.getNavHistory(fundCode, start, endDate)
                history = if (secondResponse.isSuccessful && secondResponse.body()?.ok == true) {
                    secondResponse.body()?.data.orEmpty()
                } else {
                    return Resource.Error(secondResponse.body()?.error ?: "读取历史净值失败")
                }
            }

            if (history.isNotEmpty()) {
                fundNavCacheDao.upsertAll(history.map { it.toCacheEntity(fundCode) })
            }
            Resource.Success(history)
        } catch (e: Exception) {
            Timber.e(e, "Failed to sync NAV history")
            Resource.Error(e.message ?: "历史净值同步失败")
        }
    }

    suspend fun getShellData(
        accountId: String,
        fundCode: String? = null,
        showCleared: Boolean = false
    ): Resource<FundShellDataResponse> {
        return try {
            val response = fundApi.getShellData(
                accountId = accountId,
                fundCode = fundCode,
                showCleared = if (showCleared) 1 else null
            )
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body() ?: return Resource.Error("获取基金数据失败"))
            } else {
                Resource.Error(response.body()?.error ?: "获取基金数据失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch fund shell data")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    private fun FundHoldingCacheEntity.toPositionDto(latestNav: FundNavCacheEntity? = null): FundPositionDto {
        val displayNav = latestNav?.nav ?: nav
        val displayNavDate = latestNav?.navDate ?: navDate
        val marketValue = (displayNav ?: 0.0) * units
        val floatingPnl = marketValue - cost
        return FundPositionDto(
            accountId = accountId,
            fundCode = fundCode,
            name = fundName.orEmpty(),
            fundName = fundName.orEmpty(),
            fundProductType = "fund",
            units = units,
            availableUnits = units,
            cost = cost,
            marketValue = marketValue,
            nav = displayNav,
            navDate = displayNavDate,
            floatingPnL = floatingPnl,
            floatingPnLRate = if (cost > 0) floatingPnl / cost else null,
            profit = floatingPnl + historicalProfit,
            profitRate = if (cost > 0) (floatingPnl + historicalProfit) / cost else null,
            historicalProfit = historicalProfit,
            pendingCost = pendingCost
        )
    }

    private fun TransactionCacheEntity.toFundEntryDto(): FundEntryDto = FundEntryDto(
        id = id,
        date = date,
        type = type,
        fundSubtype = fundSubtype.orEmpty(),
        amount = amount,
        fundCode = fundCode,
        fundName = fundName,
        accountId = accountId,
        accountName = accountName,
        toAccountId = toAccountId,
        toAccountName = toAccountName,
        categoryName = categoryName.orEmpty(),
        note = note,
        fundUnits = fundUnits,
        fundNav = fundNav,
        fundFee = fundFee,
        fundConfirmDate = fundConfirmDate,
        fundArrivalDate = fundArrivalDate,
        fundArrivalAmount = fundArrivalAmount,
        shares = fundUnits,
        nav = fundNav,
        fee = fundFee
    )

    private fun FundNavCacheEntity.toNavHistoryItem(): NavHistoryItem = NavHistoryItem(
        date = navDate,
        nav = nav,
        cumNav = cumNav
    )

    private fun NavHistoryItem.toCacheEntity(fundCode: String): FundNavCacheEntity = FundNavCacheEntity(
        id = "$fundCode:$date",
        fundCode = fundCode,
        navDate = date,
        nav = nav,
        cumNav = cumNav,
        name = null,
        updatedAt = date
    )

    private suspend fun upsertEntryNavCache(fundCode: String, entries: List<FundEntryDto>) {
        val navItems = entries.mapNotNull { entry ->
            val code = entry.fundCode?.takeIf { it.isNotBlank() } ?: fundCode.takeIf { it.isNotBlank() }
            val date = entry.fundConfirmDate?.takeIf { it.isNotBlank() } ?: entry.date.takeIf { it.isNotBlank() }
            val nav = entry.fundNav ?: entry.nav
            if (code == null || date == null || nav == null || nav <= 0) return@mapNotNull null
            FundNavCacheEntity(
                id = "$code:$date",
                fundCode = code,
                navDate = date.substringBefore("T"),
                nav = nav,
                cumNav = null,
                name = entry.fundName,
                updatedAt = date.substringBefore("T")
            )
        }
        if (navItems.isNotEmpty()) {
            fundNavCacheDao.upsertAll(navItems)
        }
    }

    private fun String.toLocalDateOrNull(): LocalDate? {
        return try {
            LocalDate.parse(substringBefore("T"))
        } catch (e: Exception) {
            null
        }
    }

    suspend fun getFundEntries(
        accountId: String,
        fundCode: String? = null
    ): Resource<List<FundEntryDto>> {
        return try {
            val response = fundApi.getFundEntries(accountId, fundCode)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "获取基金明细失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch fund entries")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun getNav(fundCode: String, date: String? = null): Resource<NavRecordDto> {
        return try {
            val response = fundApi.getNav(fundCode, date)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("净值不存在"))
            } else {
                Resource.Error(response.body()?.error ?: "获取净值失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch NAV")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun getNavHistory(
        fundCode: String,
        start: String? = null,
        end: String? = null
    ): Resource<List<NavHistoryItem>> {
        return try {
            val response = fundApi.getNavHistory(fundCode, start, end)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "获取净值历史失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch NAV history")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun getDailyPnl(
        accountId: String,
        year: Int,
        month: Int
    ): Resource<List<FundDayPnlDto>> {
        return try {
            val response = investApi.getDailyPnl(accountId, year, month)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.days ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "获取每日盈亏失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch daily PnL")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun setFundSettings(
        accountId: String,
        fundCode: String,
        confirmDays: Int,
        feeRate: Double
    ): Resource<Unit> {
        return try {
            val confirmResponse = fundApi.setConfirmDays(
                SetFundConfirmDaysRequest(
                    accountId = accountId,
                    fundCode = fundCode,
                    days = confirmDays
                )
            )
            if (!confirmResponse.isSuccessful || confirmResponse.body()?.ok != true) {
                return Resource.Error(confirmResponse.body()?.error ?: "保存确认天数失败")
            }

            val feeResponse = fundApi.setFeeRate(
                SetFundFeeRateRequest(
                    accountId = accountId,
                    fundCode = fundCode,
                    rate = feeRate
                )
            )
            if (!feeResponse.isSuccessful || feeResponse.body()?.ok != true) {
                return Resource.Error(feeResponse.body()?.error ?: "保存申购费率失败")
            }

            Resource.Success(Unit)
        } catch (e: Exception) {
            Timber.e(e, "Failed to save fund settings")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun getYearlyPnl(
        accountId: String,
        year: Int
    ): Resource<List<FundMonthPnlDto>> {
        return try {
            val response = investApi.getYearlyPnl(accountId, year)
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.months ?: emptyList())
            } else {
                Resource.Error(response.body()?.error ?: "获取年度盈亏失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch yearly PnL")
            Resource.Error(e.message ?: "网络错误")
        }
    }
}
