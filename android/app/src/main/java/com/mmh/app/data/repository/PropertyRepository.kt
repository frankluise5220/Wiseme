package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.PropertyAssetCacheDao
import com.mmh.app.data.local.entity.PropertyAssetCacheEntity
import com.mmh.app.data.remote.dto.PropertyAssetDto
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Repository for property assets.
 * Reads property assets from the local Room cache synced via GET /api/v1/mobile/sync.
 */
@Singleton
class PropertyRepository @Inject constructor(
    private val propertyAssetCacheDao: PropertyAssetCacheDao
) {

    suspend fun getCachedAssets(accountId: String? = null): List<PropertyAssetDto> {
        val items = if (accountId.isNullOrBlank()) {
            propertyAssetCacheDao.getAll()
        } else {
            propertyAssetCacheDao.getByAccount(accountId)
        }
        return items.map { it.toAssetDto() }
    }
}

private fun PropertyAssetCacheEntity.toAssetDto() = PropertyAssetDto(
    id = id,
    accountId = accountId,
    name = name,
    propertyType = propertyType,
    address = address,
    currency = currency,
    purchaseDate = purchaseDate,
    purchasePrice = purchasePrice,
    cost = cost,
    marketValue = marketValue,
    latestValuationDate = latestValuationDate,
    status = status,
    note = note
)
