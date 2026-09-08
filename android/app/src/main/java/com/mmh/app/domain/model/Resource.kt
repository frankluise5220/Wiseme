package com.mmh.app.domain.model

/**
 * Wrapper type for API/resource operations.
 * Represents either a successful data result or an error.
 */
sealed class Resource<out T> {
    data class Success<T>(val data: T) : Resource<T>()
    data class Error(val message: String) : Resource<Nothing>()
}