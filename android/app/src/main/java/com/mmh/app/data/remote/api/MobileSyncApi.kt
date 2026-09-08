package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.MobileSyncResponse
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Query

interface MobileSyncApi {

    @GET("api/v1/mobile/sync")
    suspend fun sync(
        @Query("since") since: String? = null,
        @Query("limit") limit: Int = 2000,
        @Query("refreshDaily") refreshDaily: Int? = null
    ): Response<MobileSyncResponse>
}
