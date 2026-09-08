package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.AccountBalanceDto
import com.mmh.app.data.remote.dto.AccountDto
import com.mmh.app.data.remote.dto.AccountGroupListResponse
import com.mmh.app.data.remote.dto.ApiResponse
import com.mmh.app.data.remote.dto.ExternalAccountListResponse
import com.mmh.app.data.remote.dto.InvestmentAccountListResponse
import com.mmh.app.data.remote.dto.CreateAccountRequest
import com.mmh.app.data.remote.dto.OkResponse
import com.mmh.app.data.remote.dto.UpdateAccountRequest
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Query

interface AccountApi {

    @POST("api/v1/accounts")
    suspend fun createAccount(@Body request: CreateAccountRequest): Response<ApiResponse<AccountDto>>

    @PUT("api/v1/accounts")
    suspend fun updateAccount(@Body request: UpdateAccountRequest): Response<OkResponse>

    @PATCH("api/v1/accounts")
    suspend fun toggleAccount(@Body request: Map<String, String>): Response<OkResponse>

    @DELETE("api/v1/accounts")
    suspend fun deleteAccount(
        @Query("id") id: String,
        @Body body: Map<String, String>? = null
    ): Response<OkResponse>

    @GET("api/v1/accounts/balances")
    suspend fun getBalances(@Query("ids") ids: String): Response<ApiResponse<List<AccountBalanceDto>>>

    @GET("api/v1/account-group")
    suspend fun getAccountGroups(): Response<AccountGroupListResponse>

    @GET("api/v1/accounts")
    suspend fun getExternalSummaries(): Response<ExternalAccountListResponse>

    @GET("api/v1/accounts/investment")
    suspend fun getInvestmentAccounts(): Response<InvestmentAccountListResponse>
}
