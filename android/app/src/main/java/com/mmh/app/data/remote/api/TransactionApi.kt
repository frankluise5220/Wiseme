package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.*
import retrofit2.Response
import retrofit2.http.*

/**
 * Transaction (TxRecord) API endpoints.
 *
 * Internal endpoints:
 *   GET    /api/v1/transactions/detail?accountId=&page=&pageSize=
 *   POST   /api/v1/transactions/detail      - Create transaction
 *   PUT    /api/v1/transactions/detail       - Update transaction
 *   DELETE /api/v1/transactions/detail?id=xxx - Delete transaction
 *   POST   /api/v1/entries/purge             - Purge multiple entries
 *
 * External endpoints (require authenticated session):
 *   GET    /api/v1/transactions?accountName=&limit=
 *
 * API: /api/v1/transactions/detail
 * Accepts entity types: TxRecord.id
 */
interface TransactionApi {

    /** Get a single transaction by its ID */
    @GET("api/v1/transactions/detail")
    suspend fun getTransactionById(
        @Query("id") id: String
    ): Response<ApiResponse<TransactionDto>>

    /** Get paginated transactions for an account */
    @GET("api/v1/transactions/detail")
    suspend fun getTransactionDetail(
        @Query("accountId") accountId: String,
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 20
    ): Response<PaginatedResponse<TransactionDto>>

    /** Create transaction */
    @POST("api/v1/transactions/detail")
    suspend fun createTransaction(@Body request: CreateTransactionRequest): Response<ApiResponse<TransactionDto>>

    /** Update transaction */
    @PUT("api/v1/transactions/detail")
    suspend fun updateTransaction(@Body request: UpdateTransactionRequest): Response<ApiResponse<TransactionDto>>

    /** Delete transaction */
    @DELETE("api/v1/transactions/detail")
    suspend fun deleteTransaction(@Query("id") id: String): Response<OkResponse>

    /** Get external transactions list */
    @GET("api/v1/transactions")
    suspend fun getExternalTransactions(
        @Query("accountName") accountName: String? = null,
        @Query("limit") limit: Int = 200
    ): Response<SingleResponse<TransactionItemDto>>
}