package com.mmh.app.ui.property

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.repository.PropertyRepository
import com.mmh.app.data.remote.dto.PropertyAssetDto
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class PropertyAssetsUiState(
    val isLoading: Boolean = false,
    val assets: List<PropertyAssetDto> = emptyList(),
    val totalMarketValue: Double = 0.0,
    val totalCost: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val error: String? = null
)

@HiltViewModel
class PropertyAssetsViewModel @Inject constructor(
    private val propertyRepository: PropertyRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(PropertyAssetsUiState())
    val uiState: StateFlow<PropertyAssetsUiState> = _uiState.asStateFlow()

    init {
        load()
    }

    fun load(accountId: String? = null) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val assets = propertyRepository.getCachedAssets(accountId)
            _uiState.value = PropertyAssetsUiState(
                isLoading = false,
                assets = assets.sortedByDescending { kotlin.math.abs(it.marketValue) },
                totalMarketValue = assets.sumOf { it.marketValue },
                totalCost = assets.sumOf { it.cost },
                floatingPnL = assets.sumOf { it.marketValue - it.cost }
            )
        }
    }
}
