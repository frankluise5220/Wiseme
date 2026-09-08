package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.InstitutionCreateResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

/**
 * Institution API endpoints.
 *
 *   POST /api/v1/institution  - Create institution
 */
interface InstitutionApi {

    /** Create institution */
    @POST("api/v1/institution")
    suspend fun createInstitution(@Body request: Map<String, String>): Response<InstitutionCreateResponse>
}
