package com.mmh.app.data.local.dao

import androidx.room.*
import com.mmh.app.data.local.entity.AccountCacheEntity

/**
 * DAO for account cache.
 */
@Dao
interface AccountCacheDao {

    @Query("SELECT * FROM account_cache ORDER BY kind, name")
    suspend fun getAll(): List<AccountCacheEntity>

    @Query("SELECT * FROM account_cache WHERE id = :id")
    suspend fun getById(id: String): AccountCacheEntity?

    @Query("SELECT * FROM account_cache WHERE isActive = 1 ORDER BY kind, name")
    suspend fun getActive(): List<AccountCacheEntity>

    @Query("SELECT * FROM account_cache WHERE kind = :kind ORDER BY name")
    suspend fun getByKind(kind: String): List<AccountCacheEntity>

    @Upsert
    suspend fun upsertAll(accounts: List<AccountCacheEntity>)

    @Query("DELETE FROM account_cache")
    suspend fun clearAll()

    @Query("SELECT COUNT(*) FROM account_cache")
    suspend fun count(): Int
}