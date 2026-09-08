package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Standard API response wrapper.
 * All MMH API endpoints return { ok: true/false, ...data } or { ok: false, error: "..." }
 */
@Serializable
data class ApiResponse<T>(
    val ok: Boolean = false,
    val data: T? = null,
    val error: String? = null
)

/** For list responses like { ok: true, data: [...] } */
@Serializable
data class ListResponse<T>(
    val ok: Boolean = false,
    val data: List<T>? = null,
    val error: String? = null
)

/** For paginated responses */
@Serializable
data class PaginatedResponse<T>(
    val ok: Boolean = false,
    val data: PaginatedData<T>? = null,
    val error: String? = null
)

@Serializable
data class PaginatedData<T>(
    val entries: List<T> = emptyList(),
    val totalCount: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val accountId: String? = null,
    val accountBalance: Double? = null
)

/** Generic single-item wrapper */
@Serializable
data class SingleResponse<T>(
    val ok: Boolean = false,
    val error: String? = null,
    val items: List<T>? = null
)

/** Simple { ok: true } response */
@Serializable
data class OkResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val message: String? = null
)