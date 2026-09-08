package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.AuthVerifyRequest
import com.mmh.app.data.remote.dto.AuthVerifyResponse
import com.mmh.app.data.remote.dto.OverviewSummaryResponse
import com.mmh.app.data.remote.dto.PingResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * Overview / utility API endpoints.
 *
 *   POST   /api/v1/auth/verify       - Username/password login
 *   GET    /api/v1/ping              - Health check
 *   GET    /api/v1/overview/summary  - Dashboard summary (net worth, month flow, asset distribution)
 */
interface OverviewApi {

    /** Verify username/password and receive session cookies */
    @POST("api/v1/auth/verify")
    suspend fun verifyAuth(@Body request: AuthVerifyRequest): Response<AuthVerifyResponse>
    /** Password reset — request verification code */
    @POST("api/v1/auth/password-reset/request")
    suspend fun passwordResetRequest(@Body body: Map<String, String>): Response<Map<String, Any>>

    /** Password reset — confirm with code and new password */
    @POST("api/v1/auth/password-reset/confirm")
    suspend fun passwordResetConfirm(@Body body: Map<String, String>): Response<Map<String, Any>>

    /** Ping server to check connection */
    @GET("api/v1/ping")
    suspend fun ping(): Response<PingResponse>

    /**
     * Dashboard summary. Single data source shared with the web overview page
     * (net worth / month income+expense / asset distribution / top positions).
     */
    @GET("api/v1/overview/summary")
    suspend fun getSummary(): Response<OverviewSummaryResponse>
}
