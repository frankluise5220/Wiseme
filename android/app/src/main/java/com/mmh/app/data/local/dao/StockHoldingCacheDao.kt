package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.StockHoldingCacheEntity

@Dao
interface StockHoldingCacheDao {

    @Query("SELECT * FROM stock_holding_cache ORDER BY account_id, ABS(cost) DESC")
    suspend fun getAll(): List<StockHoldingCacheEntity>

    @Query("SELECT * FROM stock_holding_cache WHERE account_id = :accountId ORDER BY ABS(cost) DESC")
    suspend fun getByAccount(accountId: String): List<StockHoldingCacheEntity>

    @Query("SELECT * FROM stock_holding_cache WHERE account_id = :accountId AND stock_code = :stockCode LIMIT 1")
    suspend fun getByAccountAndCode(accountId: String, stockCode: String): StockHoldingCacheEntity?

    @Upsert
    suspend fun upsertAll(items: List<StockHoldingCacheEntity>)

    @Query("DELETE FROM stock_holding_cache")
    suspend fun clearAll()
}
