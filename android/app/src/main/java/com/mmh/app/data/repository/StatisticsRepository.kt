package com.mmh.app.data.repository

import com.mmh.app.data.remote.api.StatisticsApi
import com.mmh.app.data.remote.dto.StatisticsData
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 统计数据仓库。单一数据源：GET /api/v1/statistics，
 * 与网页统计页共用同一后端计算，保证两端数据一致。
 */
@Singleton
class StatisticsRepository @Inject constructor(
    private val statisticsApi: StatisticsApi
) {

    suspend fun getStatistics(
        year: Int? = null,
        accountIds: List<String>? = null,
        tagIds: List<String>? = null
    ): Resource<StatisticsData> {
        return try {
            val response = statisticsApi.getStatistics(
                year = year,
                accounts = accountIds?.joinToString(",")?.ifBlank { null },
                tags = tagIds?.joinToString(",")?.ifBlank { null }
            )
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("统计数据为空"))
            } else {
                Resource.Error(response.body()?.error ?: "获取统计数据失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch statistics")
            Resource.Error(e.message ?: "网络错误")
        }
    }
}
