package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.FundNavCacheEntity

@Dao
interface FundNavCacheDao {

    @Query("SELECT * FROM fund_nav_cache WHERE fund_code = :fundCode ORDER BY nav_date ASC")
    suspend fun getByFundCode(fundCode: String): List<FundNavCacheEntity>

    @Query("SELECT * FROM fund_nav_cache WHERE fund_code = :fundCode ORDER BY nav_date DESC LIMIT 1")
    suspend fun getLatestByFundCode(fundCode: String): FundNavCacheEntity?

    @Query("SELECT * FROM fund_nav_cache WHERE nav_date = (SELECT MAX(nav_date) FROM fund_nav_cache latest WHERE latest.fund_code = fund_nav_cache.fund_code)")
    suspend fun getLatestAll(): List<FundNavCacheEntity>

    @Upsert
    suspend fun upsertAll(items: List<FundNavCacheEntity>)

    @Query("DELETE FROM fund_nav_cache")
    suspend fun clearAll()
}
