package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import com.mmh.app.data.local.entity.SyncStateEntity

@Dao
interface SyncStateDao {

    @Query("SELECT * FROM sync_state WHERE `key` = :key")
    suspend fun get(key: String): SyncStateEntity?

    @Upsert
    suspend fun upsert(state: SyncStateEntity)

    @Query("DELETE FROM sync_state WHERE `key` = :key")
    suspend fun delete(key: String)
}
