package com.mmh.app.di

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.mmh.app.data.local.TokenProvider
import com.mmh.app.data.remote.api.AccountApi
import com.mmh.app.data.remote.api.CategoryApi
import com.mmh.app.data.remote.api.FundApi
import com.mmh.app.data.remote.api.InstitutionApi
import com.mmh.app.data.remote.api.InvestApi
import com.mmh.app.data.remote.api.MobileSyncApi
import com.mmh.app.data.remote.api.OverviewApi
import com.mmh.app.data.remote.api.RegularInvestApi
import com.mmh.app.data.remote.api.StatisticsApi
import com.mmh.app.data.remote.api.TagApi
import com.mmh.app.data.remote.api.TransactionApi
import com.mmh.app.data.remote.interceptor.AuthInterceptor
import com.mmh.app.data.remote.interceptor.ErrorInterceptor
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    @Provides
    @Singleton
    fun provideJson(): Json = json

    @Provides
    @Singleton
    fun provideLoggingInterceptor(): HttpLoggingInterceptor {
        return HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(
        authInterceptor: AuthInterceptor,
        errorInterceptor: ErrorInterceptor,
        loggingInterceptor: HttpLoggingInterceptor
    ): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(errorInterceptor)
            .addInterceptor(loggingInterceptor)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(
        okHttpClient: OkHttpClient,
        tokenProvider: TokenProvider
    ): Retrofit {
        return Retrofit.Builder()
            .baseUrl("http://localhost/")
            .client(okHttpClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    @Provides
    @Singleton
    fun provideAccountApi(retrofit: Retrofit): AccountApi =
        retrofit.create(AccountApi::class.java)

    @Provides
    @Singleton
    fun provideTransactionApi(retrofit: Retrofit): TransactionApi =
        retrofit.create(TransactionApi::class.java)

    @Provides
    @Singleton
    fun provideFundApi(retrofit: Retrofit): FundApi =
        retrofit.create(FundApi::class.java)

    @Provides
    @Singleton
    fun provideInvestApi(retrofit: Retrofit): InvestApi =
        retrofit.create(InvestApi::class.java)

    @Provides
    @Singleton
    fun provideRegularInvestApi(retrofit: Retrofit): RegularInvestApi =
        retrofit.create(RegularInvestApi::class.java)

    @Provides
    @Singleton
    fun provideOverviewApi(retrofit: Retrofit): OverviewApi =
        retrofit.create(OverviewApi::class.java)

    @Provides
    @Singleton
    fun provideCategoryApi(retrofit: Retrofit): CategoryApi =
        retrofit.create(CategoryApi::class.java)

    @Provides
    @Singleton
    fun provideTagApi(retrofit: Retrofit): TagApi =
        retrofit.create(TagApi::class.java)

    @Provides
    @Singleton
    fun provideInstitutionApi(retrofit: Retrofit): InstitutionApi =
        retrofit.create(InstitutionApi::class.java)

    @Provides
    @Singleton
    fun provideMobileSyncApi(retrofit: Retrofit): MobileSyncApi =
        retrofit.create(MobileSyncApi::class.java)

    @Provides
    @Singleton
    fun provideStatisticsApi(retrofit: Retrofit): StatisticsApi =
        retrofit.create(StatisticsApi::class.java)
}
