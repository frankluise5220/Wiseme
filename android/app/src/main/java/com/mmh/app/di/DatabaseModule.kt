package com.mmh.app.di

import android.content.Context
import androidx.room.Room
import com.mmh.app.data.local.AppDatabase
import com.mmh.app.data.local.dao.AccountCacheDao
import com.mmh.app.data.local.dao.CategoryCacheDao
import com.mmh.app.data.local.dao.FundHoldingCacheDao
import com.mmh.app.data.local.dao.FundNavCacheDao
import com.mmh.app.data.local.dao.PropertyAssetCacheDao
import com.mmh.app.data.local.dao.RegularInvestPlanCacheDao
import com.mmh.app.data.local.dao.StockHoldingCacheDao
import com.mmh.app.data.local.dao.SyncStateDao
import com.mmh.app.data.local.dao.TransactionCacheDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase {
        return Room.databaseBuilder(
            context,
            AppDatabase::class.java,
            "mmh_cache.db"
        )
            .fallbackToDestructiveMigration()
            .build()
    }

    @Provides
    fun provideAccountCacheDao(db: AppDatabase): AccountCacheDao = db.accountCacheDao()

    @Provides
    fun provideTransactionCacheDao(db: AppDatabase): TransactionCacheDao = db.transactionCacheDao()

    @Provides
    fun provideCategoryCacheDao(db: AppDatabase): CategoryCacheDao = db.categoryCacheDao()

    @Provides
    fun provideFundHoldingCacheDao(db: AppDatabase): FundHoldingCacheDao = db.fundHoldingCacheDao()

    @Provides
    fun provideFundNavCacheDao(db: AppDatabase): FundNavCacheDao = db.fundNavCacheDao()

    @Provides
    fun provideRegularInvestPlanCacheDao(db: AppDatabase): RegularInvestPlanCacheDao = db.regularInvestPlanCacheDao()

    @Provides
    fun provideStockHoldingCacheDao(db: AppDatabase): StockHoldingCacheDao = db.stockHoldingCacheDao()

    @Provides
    fun providePropertyAssetCacheDao(db: AppDatabase): PropertyAssetCacheDao = db.propertyAssetCacheDao()

    @Provides
    fun provideSyncStateDao(db: AppDatabase): SyncStateDao = db.syncStateDao()
}
