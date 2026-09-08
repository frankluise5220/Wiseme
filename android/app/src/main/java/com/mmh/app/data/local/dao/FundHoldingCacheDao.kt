package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.FundHoldingCacheEntity

@Dao
interface FundHoldingCacheDao {

    @Query("SELECT * FROM fund_holding_cache ORDER BY account_id, ABS(cost) DESC")
    suspend fun getAll(): List<FundHoldingCacheEntity>

    @Query("SELECT * FROM fund_holding_cache WHERE account_id = :accountId ORDER BY ABS(cost) DESC")
    suspend fun getByAccount(accountId: String): List<FundHoldingCacheEntity>

    @Query("SELECT * FROM fund_holding_cache WHERE account_id = :accountId AND fund_code = :fundCode LIMIT 1")
    suspend fun getByAccountAndCode(accountId: String, fundCode: String): FundHoldingCacheEntity?

    @Query(
        """
        SELECT COUNT(*) FROM fund_holding_cache holding
        WHERE holding.units > 0
          AND NOT EXISTS (
            SELECT 1 FROM fund_nav_cache nav
            WHERE nav.fund_code = holding.fund_code
          )
        """
    )
    suspend fun countHoldingsWithoutNavCache(): Int

    @Upsert
    suspend fun upsertAll(items: List<FundHoldingCacheEntity>)

    @Query("DELETE FROM fund_holding_cache")
    suspend fun clearAll()
}
