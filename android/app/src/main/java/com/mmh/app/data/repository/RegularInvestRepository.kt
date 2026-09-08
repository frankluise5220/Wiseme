package com.mmh.app.data.repository

import com.mmh.app.data.local.dao.RegularInvestPlanCacheDao
import com.mmh.app.data.local.entity.RegularInvestPlanCacheEntity
import com.mmh.app.data.remote.api.RegularInvestApi
import com.mmh.app.data.remote.dto.CreateRegularInvestRequest
import com.mmh.app.data.remote.dto.RegularInvestPlanDto
import com.mmh.app.data.remote.dto.UpdateRegularInvestRequest
import com.mmh.app.domain.model.Resource
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class RegularInvestRepository @Inject constructor(
    private val regularInvestApi: RegularInvestApi,
    private val regularInvestPlanCacheDao: RegularInvestPlanCacheDao
) {

    suspend fun getPlans(
        accountId: String? = null,
        status: String? = null
    ): Resource<List<RegularInvestPlanDto>> {
        return try {
            val cached = regularInvestPlanCacheDao.getByStatus(status)
                .filter { accountId.isNullOrBlank() || it.accountId == accountId }
            if (cached.isNotEmpty()) {
                return Resource.Success(cached.map { it.toDto() })
            }

            val response = regularInvestApi.getPlans(accountId, status)
            if (response.isSuccessful && response.body()?.ok == true) {
                val plans = response.body()?.plans ?: emptyList()
                if (plans.isNotEmpty()) {
                    regularInvestPlanCacheDao.upsertAll(plans.map { it.toCacheEntity() })
                }
                Resource.Success(plans)
            } else {
                Resource.Error(response.body()?.error ?: "获取定投计划失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to fetch regular invest plans")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun createPlan(request: CreateRegularInvestRequest): Resource<RegularInvestPlanDto> {
        return try {
            val response = regularInvestApi.createPlan(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                val plan = response.body()?.plan ?: return Resource.Error("创建失败")
                regularInvestPlanCacheDao.upsertAll(listOf(plan.toCacheEntity()))
                Resource.Success(plan)
            } else {
                Resource.Error(response.body()?.error ?: "创建失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to create regular invest plan")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun updatePlan(request: UpdateRegularInvestRequest): Resource<RegularInvestPlanDto> {
        return try {
            val response = regularInvestApi.updatePlan(request)
            if (response.isSuccessful && response.body()?.ok == true) {
                val plan = response.body()?.plan ?: return Resource.Error("更新失败")
                regularInvestPlanCacheDao.upsertAll(listOf(plan.toCacheEntity()))
                Resource.Success(plan)
            } else {
                Resource.Error(response.body()?.error ?: "更新失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to update regular invest plan")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    suspend fun deletePlan(
        id: String,
        deleteRecords: Boolean = false
    ): Resource<Boolean> {
        return try {
            val response = regularInvestApi.deletePlan(
                id = id,
                deleteRecords = if (deleteRecords) "1" else "0"
            )
            if (response.isSuccessful && response.body()?.ok == true) {
                regularInvestPlanCacheDao.deleteById(id)
                Resource.Success(response.body()?.deletedEntries ?: false)
            } else {
                Resource.Error(response.body()?.error ?: "删除失败")
            }
        } catch (e: Exception) {
            Timber.e(e, "Failed to delete regular invest plan")
            Resource.Error(e.message ?: "网络错误")
        }
    }

    private fun RegularInvestPlanDto.toCacheEntity() = RegularInvestPlanCacheEntity(
        id = id,
        householdId = householdId,
        accountId = accountId,
        accountName = accountName,
        accountInstitutionName = accountInstitutionName,
        cashAccountId = cashAccountId,
        cashAccountName = cashAccountName,
        cashAccountInstitutionName = cashAccountInstitutionName,
        fundCode = fundCode,
        fundName = fundName,
        planName = planName,
        fundProductType = fundProductType,
        amount = amount,
        intervalUnit = intervalUnit,
        intervalValue = intervalValue,
        executionDay = executionDay,
        startDate = startDate,
        endDate = endDate,
        totalRuns = totalRuns,
        executedRuns = executedRuns,
        lastRunDate = lastRunDate,
        nextRunDate = nextRunDate,
        status = status,
        feeRate = feeRate,
        confirmDays = confirmDays,
        arrivalDays = arrivalDays,
        memo = memo,
        skipPendingPreceding = skipPendingPreceding,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun RegularInvestPlanCacheEntity.toDto() = RegularInvestPlanDto(
        id = id,
        householdId = householdId,
        accountId = accountId,
        accountName = accountName,
        accountInstitutionName = accountInstitutionName,
        cashAccountId = cashAccountId,
        cashAccountName = cashAccountName,
        cashAccountInstitutionName = cashAccountInstitutionName,
        fundCode = fundCode,
        fundName = fundName,
        planName = planName,
        fundProductType = fundProductType,
        amount = amount,
        intervalUnit = intervalUnit,
        intervalValue = intervalValue,
        executionDay = executionDay,
        startDate = startDate,
        endDate = endDate,
        totalRuns = totalRuns,
        executedRuns = executedRuns,
        lastRunDate = lastRunDate,
        nextRunDate = nextRunDate,
        status = status,
        feeRate = feeRate,
        confirmDays = confirmDays,
        arrivalDays = arrivalDays,
        memo = memo,
        skipPendingPreceding = skipPendingPreceding,
        createdAt = createdAt,
        updatedAt = updatedAt
    )
}
