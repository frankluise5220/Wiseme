package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

/**
 * Investment API endpoints.
 *
 *   GET    /api/v1/invest/daily-pnl?accountId=&year=&month=&mode=
 *   POST   /api/v1/invest/daily-pnl (sync)
 *
 * API: /api/v1/invest/daily-pnl
 * Accepts entity types: TxRecord.id (indirectly through fund holdings)
 */
interface InvestApi {

    /** Get daily PnL for a month */
    @GET("api/v1/invest/daily-pnl")
    suspend fun getDailyPnl(
        @Query("accountId") accountId: String,
        @Query("year") year: Int,
        @Query("month") month: Int? = null,
        @Query("mode") mode: String = "month"
    ): Response<DailyPnlResponse>

    /** Get yearly PnL summary */
    @GET("api/v1/invest/daily-pnl")
    suspend fun getYearlyPnl(
        @Query("accountId") accountId: String,
        @Query("year") year: Int,
        @Query("mode") mode: String = "year"
    ): Response<DailyPnlResponse>

    /** Sync investment data */
    @POST("api/v1/invest/daily-pnl")
    suspend fun syncInvestData(@Body request: Map<String, String>): Response<OkResponse>
}