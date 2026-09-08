package com.mmh.app.data.remote.interceptor

import javax.inject.Inject
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Keep network interception non-fatal.
 *
 * Retrofit callers decide how to surface 4xx/5xx responses. Throwing here can
 * crash the whole app from the OkHttp dispatcher on ordinary login failures.
 */
class ErrorInterceptor @Inject constructor() : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        return chain.proceed(chain.request())
    }
}

class ApiException(
    val code: Int,
    override val message: String
) : Exception(message)
