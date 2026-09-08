package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.StatisticsResponse
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

/**
 * Statistics API endpoints.
 *
 *   GET /api/v1/statistics?year=YYYY&accounts=id1,id2&tags=id1,id2
 */
interface StatisticsApi {

    /**
     * Get yearly financial statistics.
     * @param year year to query (default: current year on server)
     * @param accounts comma-separated account IDs filter (optional)
     * @param tags comma-separated tag IDs filter (optional)
     */
    @GET("api/v1/statistics")
    suspend fun getStatistics(
        @Query("year") year: Int? = null,
        @Query("accounts") accounts: String? = null,
        @Query("tags") tags: String? = null
    ): Response<StatisticsResponse>
}
