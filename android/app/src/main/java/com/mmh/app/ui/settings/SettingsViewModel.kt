package com.mmh.app.ui.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.local.TokenProvider
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import javax.inject.Inject

/**
 * UI state for settings screen.
 */
data class SettingsUiState(
    val activeServerId: String = "",
    val serverUrl: String = "",
    val host: String = "",
    val port: String = "",
    val protocol: String = "http:",
    val isAuthenticated: Boolean = false,
    val username: String = "",
    val householdName: String = "",
    val householdId: String = "",
    val colorScheme: String = "red_up_green_down",
    val catalog: SettingsCatalog = fallbackSettingsCatalog(),
    val savedServers: List<TokenProvider.SavedServerProfile> = emptyList()
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val tokenProvider: TokenProvider
) : ViewModel() {

    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    private val catalogJson = Json { ignoreUnknownKeys = true }

    private fun refresh() {
        _uiState.value = SettingsUiState(
            activeServerId = tokenProvider.getActiveServerId(),
            serverUrl = tokenProvider.getServerUrl(),
            host = tokenProvider.getHost(),
            port = tokenProvider.getPort(),
            protocol = tokenProvider.getProtocol(),
            isAuthenticated = tokenProvider.isConnected,
            username = tokenProvider.getUsername(),
            householdName = tokenProvider.getHouseholdName(),
            householdId = tokenProvider.getHouseholdId(),
            colorScheme = tokenProvider.getColorScheme(),
            catalog = loadCatalog(),
            savedServers = tokenProvider.getSavedServers()
        )
    }

    private fun loadCatalog(): SettingsCatalog =
        runCatching {
            context.assets.open("catalog.json").bufferedReader().use { reader ->
                catalogJson.decodeFromString<SettingsCatalog>(reader.readText())
            }
        }.getOrElse { fallbackSettingsCatalog() }

    fun updateServer(serverId: String, protocol: String, host: String, port: String) {
        viewModelScope.launch {
            if (serverId.isNotBlank()) {
                tokenProvider.updateServerProfile(serverId, protocol, host, port)
            }
            refresh()
        }
    }

    fun addServer(): String {
        val id = tokenProvider.addServer()
        refresh()
        return id
    }

    fun deleteServer(id: String) {
        viewModelScope.launch {
            tokenProvider.deleteServerProfile(id)
            refresh()
        }
    }

    fun selectServer(id: String) {
        viewModelScope.launch {
            tokenProvider.selectServerProfile(id)
            refresh()
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            tokenProvider.logout()
            refresh()
        }
    }

    fun updateColorScheme(colorScheme: String) {
        viewModelScope.launch {
            tokenProvider.setColorScheme(colorScheme)
            refresh()
        }
    }
}
