package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.RegularInvestPlanCacheEntity

@Dao
interface RegularInvestPlanCacheDao {

    @Query("SELECT * FROM regular_invest_plan_cache ORDER BY status, next_run_date ASC, fund_code ASC")
    suspend fun getAll(): List<RegularInvestPlanCacheEntity>

    @Query("SELECT * FROM regular_invest_plan_cache WHERE (:status IS NULL OR status = :status) ORDER BY next_run_date ASC, fund_code ASC")
    suspend fun getByStatus(status: String?): List<RegularInvestPlanCacheEntity>

    @Upsert
    suspend fun upsertAll(items: List<RegularInvestPlanCacheEntity>)

    @Query("DELETE FROM regular_invest_plan_cache")
    suspend fun clearAll()

    @Query("DELETE FROM regular_invest_plan_cache WHERE id = :id")
    suspend fun deleteById(id: String)
}
