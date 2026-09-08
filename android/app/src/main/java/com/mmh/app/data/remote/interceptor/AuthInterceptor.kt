package com.mmh.app.data.remote.interceptor

import com.mmh.app.data.local.TokenProvider
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject

/**
 * OkHttp interceptor for dynamic server URL and username/password session cookies.
 * No API key header is added.
 */
class AuthInterceptor @Inject constructor(
    private val tokenProvider: TokenProvider
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val baseUrl = tokenProvider.getBaseUrl().toHttpUrlOrNull()
        val requestUrl = if (baseUrl != null) {
            original.url.newBuilder()
                .scheme(baseUrl.scheme)
                .host(baseUrl.host)
                .port(baseUrl.port)
                .build()
        } else {
            original.url
        }
        val sessionCookie = tokenProvider.getSessionCookie()
        val requestBuilder = original.newBuilder().url(requestUrl)
        if (sessionCookie.isNotBlank()) {
            requestBuilder.header("Cookie", sessionCookie)
        }

        val response = chain.proceed(requestBuilder.build())
        val cookies = response.headers("Set-Cookie")
            .mapNotNull { it.substringBefore(';').takeIf(String::isNotBlank) }
        if (cookies.isNotEmpty()) {
            tokenProvider.setSessionCookie(cookies.joinToString("; "))
        }
        return response
    }
}