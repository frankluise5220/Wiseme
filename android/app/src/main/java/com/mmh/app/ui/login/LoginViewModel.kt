package com.mmh.app.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.local.TokenProvider
import com.mmh.app.data.remote.api.OverviewApi
import com.mmh.app.data.remote.dto.AuthVerifyRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed class LoginUiState {
    object Idle : LoginUiState()
    object Testing : LoginUiState()
    data class TestSuccess(val serverInfo: String? = null) : LoginUiState()
    object Ready : LoginUiState()
    data class Error(val message: String) : LoginUiState()
}

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val tokenProvider: TokenProvider,
    private val overviewApi: OverviewApi
) : ViewModel() {

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.Idle)
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    val savedProtocol: String = tokenProvider.getProtocol().ifBlank { "http:" }
    val savedHost: String = tokenProvider.getHost()
    val savedPort: String = tokenProvider.getPort()
    val savedUsername: String = tokenProvider.getUsername()

    val hasServerConfigured: Boolean = savedHost.isNotBlank()

    fun buildServerUrl(protocol: String, host: String, port: String): String {
        val p = protocol.ifBlank { "http:" }
        val h = host.trim()
        val pt = port.trim()
        return if (h.isNotBlank()) {
            if (pt.isNotBlank()) "${p}//${h}:${pt}" else "${p}//${h}"
        } else ""
    }

    fun login(protocol: String, host: String, port: String, username: String, password: String) {
        val h = host.trim()
        if (h.isBlank()) { _uiState.value = LoginUiState.Error("请填写服务器地址"); return }
        if (username.isBlank() || password.isBlank()) { _uiState.value = LoginUiState.Error("请填写用户名和密码"); return }

        val serverUrl = buildServerUrl(protocol, h, port)

        viewModelScope.launch {
            _uiState.value = LoginUiState.Testing
            tokenProvider.setProtocol(protocol.ifBlank { "http:" })
            tokenProvider.setHost(h)
            tokenProvider.setPort(port.trim())
            tokenProvider.setUsername(username.trim())
            tokenProvider.setAuthenticated(false)
            tokenProvider.setSessionCookie("")
            tokenProvider.setHouseholdId("")
            tokenProvider.setHouseholdName("")

            try {
                val response = overviewApi.verifyAuth(AuthVerifyRequest(username = username.trim(), password = password.trim()))
                val body = response.body()
                if (response.isSuccessful && body?.ok == true) {
                    tokenProvider.setUsername(body.username ?: username.trim())
                    tokenProvider.setAuthenticated(true)
                    tokenProvider.setHouseholdId(body.householdId.orEmpty())
                    tokenProvider.setHouseholdName(body.householdName.orEmpty())
                    val displayName = body.householdName?.takeIf { it.isNotBlank() }
                    _uiState.value = LoginUiState.TestSuccess(
                        serverInfo = if (displayName != null) {
                            "${body.username ?: username.trim()} 已登录到 $displayName"
                        } else {
                            "${body.username ?: username.trim()} 已登录"
                        }
                    )
                } else {
                    _uiState.value = LoginUiState.Error(body?.error ?: "登录失败")
                }
            } catch (e: Exception) {
                val msg = when {
                    e.message?.contains("Unable to resolve host") == true -> "无法解析服务器地址，请检查地址是否正确"
                    e.message?.contains("Failed to connect") == true -> "无法连接到服务器，请检查地址和端口是否正确"
                    e.message?.contains("timeout") == true -> "连接超时，请检查网络和服务器状态"
                    else -> e.message ?: "连接失败"
                }
                _uiState.value = LoginUiState.Error(msg)
            }
        }
    }

    fun saveAndConfirm() { _uiState.value = LoginUiState.Ready }

    // ── 密码找回 ──

    fun resetPasswordRequest(username: String, email: String, callback: (ok: Boolean, msgOrErr: String?) -> Unit) {
        viewModelScope.launch {
            try {
                val body = mapOf("username" to username.trim(), "email" to email.trim())
                val response = overviewApi.passwordResetRequest(body)
                val respBody = response.body()
                if (response.isSuccessful && respBody?.get("ok") == true) {
                    callback(true, respBody["message"] as? String)
                } else {
                    callback(false, (respBody?.get("error") as? String) ?: "发送失败")
                }
            } catch (e: Exception) {
                callback(false, e.message ?: "网络错误")
            }
        }
    }

    fun resetPasswordConfirm(username: String, code: String, newPassword: String, callback: (ok: Boolean, msgOrErr: String?) -> Unit) {
        viewModelScope.launch {
            try {
                val body = mapOf("username" to username.trim(), "code" to code.trim(), "newPassword" to newPassword)
                val response = overviewApi.passwordResetConfirm(body)
                val respBody = response.body()
                if (response.isSuccessful && respBody?.get("ok") == true) {
                    callback(true, respBody["message"] as? String ?: "密码重置成功")
                } else {
                    callback(false, (respBody?.get("error") as? String) ?: "重置失败")
                }
            } catch (e: Exception) {
                callback(false, e.message ?: "网络错误")
            }
        }
    }
}
