package com.mmh.app.ui.regularinvest

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.RegularInvestPlanDto
import com.mmh.app.data.remote.dto.UpdateRegularInvestRequest
import com.mmh.app.data.repository.RegularInvestRepository
import com.mmh.app.domain.model.Resource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

/**
 * UI state for the regular-invest plan list screen.
 */
data class RegularInvestUiState(
    val isLoading: Boolean = false,
    val plans: List<RegularInvestPlanDto> = emptyList(),
    val error: String? = null,
    /** 操作进行中（立即执行/暂停/恢复/停止/删除）*/
    val actionLoadingId: String? = null,
    /** 操作结果提示 */
    val toast: String? = null
)

@HiltViewModel
class RegularInvestViewModel @Inject constructor(
    private val repository: RegularInvestRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(RegularInvestUiState())
    val uiState: StateFlow<RegularInvestUiState> = _uiState.asStateFlow()

    init {
        loadPlans()
    }

    fun loadPlans() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            try {
                when (val res = repository.getPlans()) {
                    is Resource.Success -> _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        plans = res.data
                    )
                    is Resource.Error -> _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = res.message
                    )
                }
            } catch (e: Exception) {
                Timber.e(e, "Failed to load regular invest plans")
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = e.message ?: "加载定投计划失败"
                )
            }
        }
    }

    fun pause(id: String) = runAction(id) {
        repository.updatePlan(
            UpdateRegularInvestRequest(id = id, action = "pause")
        )
    }

    fun resume(id: String) = runAction(id) {
        repository.updatePlan(
            UpdateRegularInvestRequest(id = id, action = "resume")
        )
    }

    fun stop(id: String) = runAction(id) {
        repository.updatePlan(
            UpdateRegularInvestRequest(id = id, action = "stop")
        )
    }

    fun updatePlan(request: UpdateRegularInvestRequest, onSuccess: () -> Unit = {}) = runAction(request.id, onSuccess) {
        repository.updatePlan(request)
    }

    fun delete(id: String, deleteRecords: Boolean = false) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(actionLoadingId = id)
            when (val res = repository.deletePlan(id, deleteRecords)) {
                is Resource.Success -> {
                    _uiState.value = _uiState.value.copy(
                        actionLoadingId = null,
                        toast = if (deleteRecords) "已删除计划及其执行记录" else "已删除计划"
                    )
                    loadPlans()
                }
                is Resource.Error -> _uiState.value = _uiState.value.copy(
                    actionLoadingId = null,
                    toast = res.message
                )
            }
        }
    }

    fun clearToast() {
        _uiState.value = _uiState.value.copy(toast = null)
    }

    private fun runAction(
        id: String,
        onSuccess: () -> Unit = {},
        block: suspend () -> Resource<RegularInvestPlanDto>
    ) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(actionLoadingId = id)
            when (val res = block()) {
                is Resource.Success -> {
                    _uiState.value = _uiState.value.copy(
                        actionLoadingId = null,
                        toast = "操作成功"
                    )
                    onSuccess()
                    loadPlans()
                }
                is Resource.Error -> _uiState.value = _uiState.value.copy(
                    actionLoadingId = null,
                    toast = res.message
                )
            }
        }
    }
}
