package com.mmh.app.data.local.dao

import androidx.room.*
import com.mmh.app.data.local.entity.CategoryCacheEntity

/**
 * DAO for category cache.
 */
@Dao
interface CategoryCacheDao {

    @Query("SELECT * FROM category_cache ORDER BY type, name")
    suspend fun getAll(): List<CategoryCacheEntity>

    @Query("SELECT * FROM category_cache WHERE type = :type ORDER BY name")
    suspend fun getByType(type: String): List<CategoryCacheEntity>

    @Upsert
    suspend fun upsertAll(categories: List<CategoryCacheEntity>)

    @Query("DELETE FROM category_cache")
    suspend fun clearAll()

    @Query("SELECT COUNT(*) FROM category_cache")
    suspend fun count(): Int
}