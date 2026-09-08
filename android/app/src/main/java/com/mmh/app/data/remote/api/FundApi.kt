package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

/**
 * Fund API endpoints.
 *
 *   GET    /api/v1/fund/shell-data?accountId=&fundCode=&showCleared=1
 *   GET    /api/v1/fund/entries?accountId=&fundCode=
 *   GET    /api/v1/fund/nav?fundCode=&date=
 *   POST   /api/v1/fund/nav       - Set NAV
 *   PUT    /api/v1/fund/nav       - Update NAV
 *   POST   /api/v1/fund/position  - Create position
 *   POST   /api/v1/fund/confirm-days - Set confirm days
 *   POST   /api/v1/fund/fee-rate  - Set fee rate
 *   POST   /api/v1/fund/fix-linkage - Fix fund linkage
 *
 * API: /api/v1/fund/shell-data
 * Accepts entity types: FundEntry.id (in allEntries)
 */
interface FundApi {

    /** Get fund shell data (positions, entries, config) */
    @GET("api/v1/fund/shell-data")
    suspend fun getShellData(
        @Query("accountId") accountId: String,
        @Query("fundCode") fundCode: String? = null,
        @Query("showCleared") showCleared: Int? = null
    ): Response<FundShellDataResponse>

    /** Get fund entries */
    @GET("api/v1/fund/entries")
    suspend fun getFundEntries(
        @Query("accountId") accountId: String,
        @Query("fundCode") fundCode: String? = null
    ): Response<ApiResponse<List<FundEntryDto>>>

    /** Get NAV for a fund on a specific date */
    @GET("api/v1/fund/nav")
    suspend fun getNav(
        @Query("fundCode") fundCode: String,
        @Query("date") date: String? = null
    ): Response<ApiResponse<NavRecordDto>>

    /** Set NAV */
    @POST("api/v1/fund/nav")
    suspend fun setNav(@Body request: Map<String, String>): Response<OkResponse>

    /** Update NAV */
    @PUT("api/v1/fund/nav")
    suspend fun updateNav(@Body request: Map<String, String>): Response<OkResponse>

    /** Create fund position */
    @POST("api/v1/fund/position")
    suspend fun createPosition(@Body request: CreateFundPositionRequest): Response<OkResponse>

    /** Set confirm days */
    @POST("api/v1/fund/confirm-days")
    suspend fun setConfirmDays(@Body request: SetFundConfirmDaysRequest): Response<OkResponse>

    /** Set fee rate */
    @POST("api/v1/fund/fee-rate")
    suspend fun setFeeRate(@Body request: SetFundFeeRateRequest): Response<OkResponse>

    /** Fix fund linkage */
    @POST("api/v1/fund/fix-linkage")
    suspend fun fixLinkage(): Response<OkResponse>

    /** Get NAV history for charting */
    @GET("api/v1/fund/nav/history")
    suspend fun getNavHistory(
        @Query("code") code: String,
        @Query("start") start: String? = null,
        @Query("end") end: String? = null
    ): Response<NavHistoryResponse>

    /** Preload NAV history into the server cache before the Android client pulls it into Room. */
    @POST("api/v1/fund/preload-nav")
    suspend fun preloadNavHistory(@Body request: PreloadNavRequest): Response<OkResponse>
}
