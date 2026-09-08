package com.mmh.app.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
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

/**
 * Room database for local caching of API data.
 * Used to reduce network requests and provide offline support.
 */
@Database(
    entities = [
        AccountCacheEntity::class,
        TransactionCacheEntity::class,
        CategoryCacheEntity::class,
        FundHoldingCacheEntity::class,
        FundNavCacheEntity::class,
        RegularInvestPlanCacheEntity::class,
        StockHoldingCacheEntity::class,
        PropertyAssetCacheEntity::class,
        SyncStateEntity::class
    ],
    version = 9,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun accountCacheDao(): AccountCacheDao
    abstract fun transactionCacheDao(): TransactionCacheDao
    abstract fun categoryCacheDao(): CategoryCacheDao
    abstract fun fundHoldingCacheDao(): FundHoldingCacheDao
    abstract fun fundNavCacheDao(): FundNavCacheDao
    abstract fun regularInvestPlanCacheDao(): RegularInvestPlanCacheDao
    abstract fun stockHoldingCacheDao(): StockHoldingCacheDao
    abstract fun propertyAssetCacheDao(): PropertyAssetCacheDao
    abstract fun syncStateDao(): SyncStateDao
}
