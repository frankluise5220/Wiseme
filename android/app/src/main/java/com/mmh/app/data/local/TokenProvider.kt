package com.mmh.app.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * Encrypted storage for server connection and login state.
 *
 * 存储方式：
 * - host: 服务器主机名/IP（如 192.168.1.100）
 * - port: 端口号（如 3000），空字符串表示使用默认端口
 * - protocol: "http:" 或 "https:"
 * - 完整 URL 由 getServerUrl() 动态拼接，不再让用户手输冒号
 */
@Singleton
class TokenProvider @Inject constructor(
    @ApplicationContext context: Context
) {
    @Serializable
    data class SavedServerProfile(
        val id: String,
        val protocol: String = "http:",
        val host: String = "",
        val port: String = "",
        val username: String = "",
        val householdId: String = "",
        val householdName: String = ""
    ) {
        val serverUrl: String
            get() = if (host.isBlank()) "" else if (port.isNotBlank()) "${protocol}//${host}:${port}" else "${protocol}//${host}"
    }

    private val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
    private val json = Json { ignoreUnknownKeys = true }

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        PREFS_NAME,
        masterKeyAlias,
        context,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var isConnectedState by mutableStateOf(
        getServerUrl().isNotBlank() && prefs.getBoolean(KEY_AUTHENTICATED, false)
    )
        private set

    var colorSchemeState by mutableStateOf(getColorScheme())
        private set

    var savedServersState by mutableStateOf(getSavedServers())
        private set

    // ── Server connection parts (split for Chinese keyboard friendliness) ──

    /** e.g. "192.168.1.100" or "myserver.local" */
    fun getHost(): String = prefs.getString(KEY_HOST, "") ?: ""

    fun setHost(host: String) {
        prefs.edit().putString(KEY_HOST, host).apply()
        isConnectedState = getServerUrl().isNotBlank() && prefs.getBoolean(KEY_AUTHENTICATED, false)
        syncCurrentServerProfile()
    }

    /** e.g. "3000". Empty string = use default (no port in URL) */
    fun getPort(): String = prefs.getString(KEY_PORT, "") ?: ""

    fun setPort(port: String) {
        prefs.edit().putString(KEY_PORT, port).apply()
        isConnectedState = getServerUrl().isNotBlank() && prefs.getBoolean(KEY_AUTHENTICATED, false)
        syncCurrentServerProfile()
    }

    /** "http:" or "https:" */
    fun getProtocol(): String = prefs.getString(KEY_PROTOCOL, "http:") ?: "http:"

    fun setProtocol(protocol: String) {
        prefs.edit().putString(KEY_PROTOCOL, protocol).apply()
        syncCurrentServerProfile()
    }

    // ── Composite server URL ──

    /** Full server URL, assembled from parts, e.g. "http://192.168.1.100:3000" */
    fun getServerUrl(): String {
        val host = getHost()
        if (host.isBlank()) return getLegacyServerUrl()
        val protocol = getProtocol()
        val port = getPort()
        return if (port.isNotBlank()) "${protocol}//${host}:${port}" else "${protocol}//${host}"
    }

    /** Legacy: fallback to old KEY_SERVER_URL for backward compatibility */
    private fun getLegacyServerUrl(): String {
        val legacy = prefs.getString(KEY_SERVER_URL, "") ?: ""
        if (legacy.isNotBlank()) {
            // Migrate: parse and save as parts, clear legacy
            try {
                val u = java.net.URI(legacy)
                prefs.edit()
                    .putString(KEY_PROTOCOL, u.scheme + ":")
                    .putString(KEY_HOST, u.host ?: "")
                    .putString(KEY_PORT, if (u.port > 0) u.port.toString() else "")
                    .remove(KEY_SERVER_URL)
                    .apply()
                return legacy.trimEnd('/')
            } catch (_: Exception) {
                // Use as-is if parsing fails
            }
        }
        return ""
    }

    fun setServerUrl(url: String) {
        // Decompose and save as parts
        try {
            val u = java.net.URI(url)
            prefs.edit()
                .putString(KEY_PROTOCOL, u.scheme + ":")
                .putString(KEY_HOST, u.host ?: "")
                .putString(KEY_PORT, if (u.port > 0) u.port.toString() else "")
                .putString(KEY_USERNAME, "")  // Clear username on server change
                .putBoolean(KEY_AUTHENTICATED, false)
                .apply()
        } catch (_: Exception) {
            // If URL parsing fails, store as legacy
            prefs.edit().putString(KEY_SERVER_URL, url).apply()
        }
        isConnectedState = url.isNotBlank() && prefs.getBoolean(KEY_AUTHENTICATED, false)
        syncCurrentServerProfile()
    }

    // ── Login State ──

    fun getUsername(): String = prefs.getString(KEY_USERNAME, "") ?: ""

    fun setUsername(username: String) {
        prefs.edit().putString(KEY_USERNAME, username).apply()
        syncCurrentServerProfile()
    }

    fun setAuthenticated(authenticated: Boolean) {
        prefs.edit().putBoolean(KEY_AUTHENTICATED, authenticated).apply()
        isConnectedState = getServerUrl().isNotBlank() && authenticated
    }

    fun getSessionCookie(): String = prefs.getString(KEY_SESSION_COOKIE, "") ?: ""

    fun setSessionCookie(cookie: String) {
        prefs.edit().putString(KEY_SESSION_COOKIE, cookie).apply()
    }

    // ── Household ──

    fun getHouseholdId(): String = prefs.getString(KEY_HOUSEHOLD_ID, "") ?: ""

    fun setHouseholdId(id: String) {
        prefs.edit().putString(KEY_HOUSEHOLD_ID, id).apply()
        syncCurrentServerProfile()
    }

    fun getHouseholdName(): String = prefs.getString(KEY_HOUSEHOLD_NAME, "") ?: ""

    fun setHouseholdName(name: String) {
        prefs.edit().putString(KEY_HOUSEHOLD_NAME, name).apply()
        syncCurrentServerProfile()
    }

    fun getActiveServerId(): String = prefs.getString(KEY_ACTIVE_SERVER_ID, "") ?: ""

    fun getSavedServers(): List<SavedServerProfile> {
        val raw = prefs.getString(KEY_SERVER_PROFILES, "") ?: ""
        if (raw.isBlank()) return emptyList()
        return try {
            json.decodeFromString<List<SavedServerProfile>>(raw)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun addServer(protocol: String = "http:", host: String = "", port: String = ""): String {
        val id = UUID.randomUUID().toString()
        val list = getSavedServers().toMutableList()
        list.add(
            SavedServerProfile(
                id = id,
                protocol = protocol,
                host = host,
                port = port
            )
        )
        saveServerProfiles(list, activeId = id)
        applyServerProfile(list.last())
        return id
    }

    fun updateServerProfile(id: String, protocol: String, host: String, port: String) {
        val updated = getSavedServers().map {
            if (it.id == id) it.copy(protocol = protocol, host = host.trim(), port = port.trim()) else it
        }
        saveServerProfiles(updated, activeId = id)
        updated.firstOrNull { it.id == id }?.let { applyServerProfile(it, keepAuthState = false) }
    }

    fun deleteServerProfile(id: String) {
        val remaining = getSavedServers().filterNot { it.id == id }
        val nextActiveId = when {
            remaining.isEmpty() -> ""
            getActiveServerId() == id -> remaining.first().id
            else -> getActiveServerId()
        }
        saveServerProfiles(remaining, activeId = nextActiveId)
        if (remaining.isEmpty()) {
            prefs.edit()
                .putString(KEY_PROTOCOL, "http:")
                .putString(KEY_HOST, "")
                .putString(KEY_PORT, "")
                .putString(KEY_USERNAME, "")
                .putString(KEY_HOUSEHOLD_ID, "")
                .putString(KEY_HOUSEHOLD_NAME, "")
                .putBoolean(KEY_AUTHENTICATED, false)
                .putString(KEY_SESSION_COOKIE, "")
                .apply()
            isConnectedState = false
        } else {
            remaining.firstOrNull { it.id == nextActiveId }?.let { applyServerProfile(it, keepAuthState = false) }
        }
    }

    fun selectServerProfile(id: String) {
        getSavedServers().firstOrNull { it.id == id }?.let {
            saveServerProfiles(getSavedServers(), activeId = id)
            applyServerProfile(it, keepAuthState = false)
        }
    }

    // ── App Preferences ──

    fun getColorScheme(): String = prefs.getString(KEY_COLOR_SCHEME, "red_up_green_down")
        ?: "red_up_green_down"

    fun setColorScheme(colorScheme: String) {
        val normalized = when (colorScheme) {
            "green_up_red_down" -> "green_up_red_down"
            else -> "red_up_green_down"
        }
        prefs.edit().putString(KEY_COLOR_SCHEME, normalized).apply()
        colorSchemeState = normalized
    }

    // ── Connection Status ──

    val isConnected: Boolean
        get() = getServerUrl().isNotBlank() && prefs.getBoolean(KEY_AUTHENTICATED, false)

    /** Get the base URL (with trailing slash) for Retrofit */
    fun getBaseUrl(): String {
        val url = getServerUrl().trimEnd('/')
        return if (url.isNotBlank()) "$url/" else ""
    }

    /** Clear all stored credentials (logout) */
    fun clear() {
        prefs.edit().clear().apply()
        isConnectedState = false
        colorSchemeState = getColorScheme()
        savedServersState = emptyList()
    }

    /** Logout current account but keep server config and app-side preferences. */
    fun logout() {
        val protocol = getProtocol()
        val host = getHost()
        val port = getPort()
        val username = getUsername()
        val colorScheme = getColorScheme()

        prefs.edit().clear().apply()
        prefs.edit()
            .putString(KEY_PROTOCOL, protocol)
            .putString(KEY_HOST, host)
            .putString(KEY_PORT, port)
            .putString(KEY_USERNAME, username)
            .putString(KEY_COLOR_SCHEME, colorScheme)
            .putBoolean(KEY_AUTHENTICATED, false)
            .putString(KEY_SESSION_COOKIE, "")
            .putString(KEY_HOUSEHOLD_ID, "")
            .putString(KEY_HOUSEHOLD_NAME, "")
            .apply()
        isConnectedState = false
        colorSchemeState = colorScheme
        syncCurrentServerProfile()
    }

    private fun syncCurrentServerProfile() {
        val host = getHost().trim()
        val port = getPort().trim()
        val protocol = getProtocol()
        val username = getUsername()
        val householdId = getHouseholdId()
        val householdName = getHouseholdName()

        val currentId = getActiveServerId()
        val list = getSavedServers().toMutableList()

        if (host.isBlank()) {
            savedServersState = list
            return
        }

        val targetId = when {
            currentId.isNotBlank() -> currentId
            else -> UUID.randomUUID().toString()
        }

        val updatedProfile = SavedServerProfile(
            id = targetId,
            protocol = protocol,
            host = host,
            port = port,
            username = username,
            householdId = householdId,
            householdName = householdName
        )

        val index = list.indexOfFirst { it.id == targetId }
        if (index >= 0) list[index] = updatedProfile else list.add(updatedProfile)
        saveServerProfiles(list, activeId = targetId)
    }

    private fun saveServerProfiles(profiles: List<SavedServerProfile>, activeId: String = getActiveServerId()) {
        prefs.edit()
            .putString(KEY_SERVER_PROFILES, json.encodeToString(profiles))
            .putString(KEY_ACTIVE_SERVER_ID, activeId)
            .apply()
        savedServersState = profiles
    }

    private fun applyServerProfile(profile: SavedServerProfile, keepAuthState: Boolean = false) {
        prefs.edit()
            .putString(KEY_ACTIVE_SERVER_ID, profile.id)
            .putString(KEY_PROTOCOL, profile.protocol)
            .putString(KEY_HOST, profile.host)
            .putString(KEY_PORT, profile.port)
            .putString(KEY_USERNAME, profile.username)
            .putString(KEY_HOUSEHOLD_ID, profile.householdId)
            .putString(KEY_HOUSEHOLD_NAME, profile.householdName)
            .putBoolean(KEY_AUTHENTICATED, if (keepAuthState) prefs.getBoolean(KEY_AUTHENTICATED, false) else false)
            .putString(KEY_SESSION_COOKIE, if (keepAuthState) getSessionCookie() else "")
            .apply()
        isConnectedState = getServerUrl().isNotBlank() && if (keepAuthState) prefs.getBoolean(KEY_AUTHENTICATED, false) else false
    }

    companion object {
        private const val PREFS_NAME = "mmh_secure_prefs"
        // Legacy (kept for backward compatibility migration)
        private const val KEY_SERVER_URL = "server_url"
        // New split keys
        private const val KEY_PROTOCOL = "server_protocol"
        private const val KEY_HOST = "server_host"
        private const val KEY_PORT = "server_port"
        private const val KEY_ACTIVE_SERVER_ID = "active_server_id"
        private const val KEY_SERVER_PROFILES = "server_profiles"
        // Auth keys
        private const val KEY_USERNAME = "username"
        private const val KEY_AUTHENTICATED = "authenticated"
        private const val KEY_SESSION_COOKIE = "session_cookie"
        private const val KEY_HOUSEHOLD_ID = "household_id"
        private const val KEY_HOUSEHOLD_NAME = "household_name"
        private const val KEY_COLOR_SCHEME = "color_scheme"
    }
}
