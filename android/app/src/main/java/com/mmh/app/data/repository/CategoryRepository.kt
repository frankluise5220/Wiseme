package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.CategoryCacheDao
import com.mmh.app.data.local.entity.CategoryCacheEntity
import com.mmh.app.data.remote.api.CategoryApi
import com.mmh.app.data.remote.dto.CategoryItemDto
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CategoryRepository @Inject constructor(
    private val categoryApi: CategoryApi,
    private val categoryCacheDao: CategoryCacheDao
) {

    suspend fun getCategories(type: String? = null, forceRefresh: Boolean = false): Resource<List<CategoryItemDto>> {
        return try {
            if (!forceRefresh) {
                val cached = if (type.isNullOrBlank()) {
                    categoryCacheDao.getAll()
                } else {
                    categoryCacheDao.getByType(type)
                }
                if (cached.isNotEmpty()) {
                    return Resource.Success(cached.map { it.toDto() })
                }
            }

            val response = categoryApi.getCategories(type)
            val body = response.body()
            if (response.isSuccessful && body?.ok == true) {
                val categories = body.categories ?: emptyList()
                if (categories.isNotEmpty()) {
                    categoryCacheDao.upsertAll(categories.map { it.toCacheEntity() })
                }
                Resource.Success(categories)
            } else {
                val fallback = if (type.isNullOrBlank()) categoryCacheDao.getAll() else categoryCacheDao.getByType(type)
                if (fallback.isNotEmpty()) {
                    Resource.Success(fallback.map { it.toDto() })
                } else {
                    Resource.Error(body?.error ?: "获取分类失败")
                }
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch categories")
            val fallback = if (type.isNullOrBlank()) categoryCacheDao.getAll() else categoryCacheDao.getByType(type)
            if (fallback.isNotEmpty()) {
                Resource.Success(fallback.map { it.toDto() })
            } else {
                Resource.Error(e.message ?: "网络错误")
            }
        }
    }

    suspend fun getCachedCategories(type: String? = null): List<CategoryItemDto> {
        val cached = if (type.isNullOrBlank()) {
            categoryCacheDao.getAll()
        } else {
            categoryCacheDao.getByType(type)
        }
        return cached.map { it.toDto() }
    }

    private fun CategoryItemDto.toCacheEntity() = CategoryCacheEntity(
        id = id,
        name = name,
        type = type,
        parentId = parentId
    )

    private fun CategoryCacheEntity.toDto() = CategoryItemDto(
        id = id,
        name = name,
        type = type,
        parentId = parentId
    )
}
