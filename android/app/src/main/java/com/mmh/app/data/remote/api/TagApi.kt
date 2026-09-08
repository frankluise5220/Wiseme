package com.mmh.app.data.remote.api

import com.mmh.app.data.remote.dto.ApiResponse
import com.mmh.app.data.remote.dto.OkResponse
import com.mmh.app.data.remote.dto.TagDto
import com.mmh.app.data.remote.dto.TagListResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * Tag API endpoints.
 *
 *   GET    /api/v1/tags   - List tags
 *   POST   /api/v1/tags   - Create tag
 *   DELETE /api/v1/tags?id=  - Delete tag
 */
interface TagApi {

    /** List all tags */
    @GET("api/v1/tags")
    suspend fun getTags(): Response<TagListResponse>

    /** Create tag */
    @POST("api/v1/tags")
    suspend fun createTag(@Body request: Map<String, String?>): Response<ApiResponse<TagDto>>

    /** Delete tag */
    @DELETE("api/v1/tags")
    suspend fun deleteTag(@Query("id") id: String): Response<OkResponse>
}
