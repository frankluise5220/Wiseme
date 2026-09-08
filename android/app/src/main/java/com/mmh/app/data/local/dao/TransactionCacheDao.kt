package com.mmh.app.data.local.dao

import androidx.room.*
import com.mmh.app.data.local.entity.TransactionCacheEntity

/**
 * DAO for transaction cache.
 */
@Dao
interface TransactionCacheDao {

    @Query("SELECT * FROM transaction_cache WHERE account_id = :accountId AND page = :page ORDER BY date DESC")
    suspend fun getByAccountAndPage(accountId: String, page: Int): List<TransactionCacheEntity>

    @Query("SELECT * FROM transaction_cache WHERE account_id = :accountId ORDER BY date DESC LIMIT :limit")
    suspend fun getRecentByAccount(accountId: String, limit: Int = 20): List<TransactionCacheEntity>

    @Query("SELECT * FROM transaction_cache WHERE (account_id = :accountId OR to_account_id = :accountId) AND fund_code = :fundCode ORDER BY date DESC")
    suspend fun getFundEntries(accountId: String, fundCode: String): List<TransactionCacheEntity>

    @Query("SELECT * FROM transaction_cache ORDER BY date DESC LIMIT :limit")
    suspend fun getRecent(limit: Int = 200): List<TransactionCacheEntity>

    @Upsert
    suspend fun upsertAll(transactions: List<TransactionCacheEntity>)

    @Query("DELETE FROM transaction_cache WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("DELETE FROM transaction_cache WHERE account_id = :accountId")
    suspend fun deleteByAccount(accountId: String)

    @Query("DELETE FROM transaction_cache")
    suspend fun clearAll()
}
