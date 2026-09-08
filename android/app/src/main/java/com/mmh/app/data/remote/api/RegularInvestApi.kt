package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

/**
 * Regular Investment Plan API endpoints.
 *
 *   GET    /api/v1/regular-invest?accountId=&status=
 *   POST   /api/v1/regular-invest
 *   PUT    /api/v1/regular-invest
 *   DELETE /api/v1/regular-invest?id=&deleteRecords=
 *
 * API: /api/v1/regular-invest
 * Accepts entity types: RegularInvestPlan.id
 */
interface RegularInvestApi {

    /** List regular invest plans */
    @GET("api/v1/regular-invest")
    suspend fun getPlans(
        @Query("accountId") accountId: String? = null,
        @Query("status") status: String? = null
    ): Response<RegularInvestListResponse>

    /** Create regular invest plan */
    @POST("api/v1/regular-invest")
    suspend fun createPlan(@Body request: CreateRegularInvestRequest): Response<RegularInvestSingleResponse>

    /** Update regular invest plan (or pause/resume/stop) */
    @PUT("api/v1/regular-invest")
    suspend fun updatePlan(@Body request: UpdateRegularInvestRequest): Response<RegularInvestSingleResponse>

    /** Delete regular invest plan */
    @DELETE("api/v1/regular-invest")
    suspend fun deletePlan(
        @Query("id") id: String,
        @Query("deleteRecords") deleteRecords: String = "0"
    ): Response<RegularInvestSingleResponse>
}