package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.ApiResponse
import com.mmh.app.data.remote.dto.CategoryDto
import com.mmh.app.data.remote.dto.CategoryListResponseDto
import com.mmh.app.data.remote.dto.InstitutionCreateResponse
import com.mmh.app.data.remote.dto.OkResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Query

/**
 * Category API endpoints.
 *
 *   GET    /api/v1/category?type=   - List categories (with optional type filter)
 *   POST   /api/v1/category
 *   POST   /api/v1/institution
 *   POST   /api/v1/account-group
 *   PUT    /api/v1/account-group
 */
interface CategoryApi {

    /** List categories with the current authenticated session */
    @GET("api/v1/category")
    suspend fun getCategories(
        @Query("type") type: String? = null
    ): Response<CategoryListResponseDto>

    /** Create category */
    @POST("api/v1/category")
    suspend fun createCategory(@Body request: Map<String, String?>): Response<ApiResponse<CategoryDto>>

    /** Create institution */
    @POST("api/v1/institution")
    suspend fun createInstitution(@Body request: Map<String, String>): Response<InstitutionCreateResponse>

    /** Create account group */
    @POST("api/v1/account-group")
    suspend fun createAccountGroup(@Body request: Map<String, String>): Response<OkResponse>

    /** Update account group */
    @PUT("api/v1/account-group")
    suspend fun updateAccountGroup(@Body request: Map<String, String>): Response<OkResponse>
}

