package com.mmh.app.data.repository

import com.mmh.app.data.remote.api.OverviewApi
import com.mmh.app.data.remote.dto.OverviewSummaryDto
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 总览数据仓库。单一数据源：GET /api/v1/overview/summary，
 * 与网页总览页共用同一后端计算，保证两端金额一致。
 */
@Singleton
class OverviewRepository @Inject constructor(
    private val overviewApi: OverviewApi
) {

    suspend fun getSummary(): Resource<OverviewSummaryDto> {
        return try {
            val response = overviewApi.getSummary()
            if (response.isSuccessful && response.body()?.ok == true) {
                Resource.Success(response.body()?.data ?: return Resource.Error("总览数据为空"))
            } else {
                Resource.Error(response.body()?.error ?: "获取总览数据失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch overview summary")
            Resource.Error(e.message ?: "网络错误")
        }
    }
}
