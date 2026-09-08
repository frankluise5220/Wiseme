package com.mmh.app.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.local.TokenProvider
import com.mmh.app.data.repository.MobileSyncRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

data class MainUiState(
    val username: String = "",
    val householdName: String = ""
) {
    val displayName: String
        get() = householdName.ifBlank { username.ifBlank { "\u672a\u767b\u5f55" } }
}

@HiltViewModel
class MainViewModel @Inject constructor(
    tokenProvider: TokenProvider,
    private val mobileSyncRepository: MobileSyncRepository
) : ViewModel() {
    val uiState = MainUiState(
        username = tokenProvider.getUsername(),
        householdName = tokenProvider.getHouseholdName()
    )

    init {
        viewModelScope.launch(Dispatchers.IO) {
            delay(3_000)
            Timber.d("Daily mobile sync finished: %s", mobileSyncRepository.syncDailyIfNeeded())
        }
    }
}
