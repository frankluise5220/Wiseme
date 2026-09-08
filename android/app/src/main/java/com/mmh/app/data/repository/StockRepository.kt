package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.StockHoldingCacheDao
import com.mmh.app.data.local.entity.StockHoldingCacheEntity
import com.mmh.app.data.remote.dto.StockHoldingDto
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Repository for stock holdings.
 * Reads stock positions from the local Room cache synced via GET /api/v1/mobile/sync.
 */
@Singleton
class StockRepository @Inject constructor(
    private val stockHoldingCacheDao: StockHoldingCacheDao
) {

    suspend fun getCachedHoldings(accountId: String? = null): List<StockHoldingDto> {
        val items = if (accountId.isNullOrBlank()) {
            stockHoldingCacheDao.getAll()
        } else {
            stockHoldingCacheDao.getByAccount(accountId)
        }
        return items.map { it.toHoldingDto() }
    }
}

private fun StockHoldingCacheEntity.toHoldingDto() = StockHoldingDto(
    id = id,
    accountId = accountId,
    securityId = securityId,
    market = market,
    stockCode = stockCode,
    stockName = stockName ?: "",
    quantity = quantity,
    avgCost = avgCost,
    cost = cost,
    latestPrice = latestPrice,
    marketValue = marketValue,
    floatingPnL = floatingPnL,
    historicalProfit = historicalProfit
)
