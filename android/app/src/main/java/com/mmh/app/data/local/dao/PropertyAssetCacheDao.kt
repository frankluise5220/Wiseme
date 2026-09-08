package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.PropertyAssetCacheEntity

@Dao
interface PropertyAssetCacheDao {

    @Query("SELECT * FROM property_asset_cache ORDER BY account_id, ABS(market_value) DESC")
    suspend fun getAll(): List<PropertyAssetCacheEntity>

    @Query("SELECT * FROM property_asset_cache WHERE account_id = :accountId ORDER BY ABS(market_value) DESC")
    suspend fun getByAccount(accountId: String): List<PropertyAssetCacheEntity>

    @Upsert
    suspend fun upsertAll(items: List<PropertyAssetCacheEntity>)

    @Query("DELETE FROM property_asset_cache")
    suspend fun clearAll()
}
