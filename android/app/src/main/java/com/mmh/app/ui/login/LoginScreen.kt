package com.mmh.app.ui.login

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel

private val Blue600 = Color(0xFF1677FF)
private val Blue500 = Color(0xFF2F8CFF)
private val Blue50 = Color(0xFFF3F8FF)
private val Slate900 = Color(0xFF111827)
private val Slate700 = Color(0xFF475569)
private val Slate500 = Color(0xFF64748B)
private val Slate300 = Color(0xFFD7DFEA)
private val PageBg = Color(0xFFFFFFFF)
private val SuccessGreen = Color(0xFF16A34A)

@Composable
fun LoginScreen(
    onLoginSuccess: () -> Unit,
    viewModel: LoginViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val focusManager = LocalFocusManager.current
    val scrollState = rememberScrollState()

    var protocol by remember { mutableStateOf(viewModel.savedProtocol) }
    var host by remember { mutableStateOf(viewModel.savedHost) }
    var port by remember { mutableStateOf(viewModel.savedPort) }
    var username by remember { mutableStateOf(viewModel.savedUsername) }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }

    val serverConfigured = viewModel.hasServerConfigured
    var showServerConfig by remember { mutableStateOf(!serverConfigured) }
    var useHttps by remember { mutableStateOf(protocol == "https:") }

    var showResetPassword by remember { mutableStateOf(false) }
    var resetEmail by remember { mutableStateOf("") }
    var resetCode by remember { mutableStateOf("") }
    var resetNewPassword by remember { mutableStateOf("") }
    var resetConfirmPassword by remember { mutableStateOf("") }
    var resetStep by remember { mutableStateOf("request") }
    var resetInfo by remember { mutableStateOf("") }
    var resetError by remember { mutableStateOf("") }
    var resetLoading by remember { mutableStateOf(false) }

    fun syncProtocol() {
        protocol = if (useHttps) "https:" else "http:"
    }

    fun doLogin() {
        syncProtocol()
        viewModel.login(protocol, host, port, username, password)
    }

    fun doResetRequest() {
        if (username.isBlank()) {
            resetError = "请先填写用户名"
            return
        }
        if (resetEmail.isBlank()) {
            resetError = "请输入找回邮箱"
            return
        }
        resetLoading = true
        resetError = ""
        resetInfo = ""
        viewModel.resetPasswordRequest(username.trim(), resetEmail.trim()) { ok, msgOrErr ->
            resetLoading = false
            if (ok) {
                resetInfo = msgOrErr ?: "如果邮箱匹配，将收到验证码"
                resetStep = "confirm"
            } else {
                resetError = msgOrErr ?: "发送失败"
            }
        }
    }

    fun doResetConfirm() {
        if (resetCode.isBlank()) {
            resetError = "请输入验证码"
            return
        }
        if (resetNewPassword.isBlank()) {
            resetError = "请输入新密码"
            return
        }
        if (resetNewPassword != resetConfirmPassword) {
            resetError = "两次密码不一致"
            return
        }
        resetLoading = true
        resetError = ""
        resetInfo = ""
        viewModel.resetPasswordConfirm(username.trim(), resetCode.trim(), resetNewPassword) { ok, msgOrErr ->
            resetLoading = false
            if (ok) {
                resetInfo = msgOrErr ?: "密码已重置"
                resetStep = "request"
                showResetPassword = false
            } else {
                resetError = msgOrErr ?: "重置失败"
            }
        }
    }

    Scaffold(
        containerColor = PageBg,
        contentWindowInsets = WindowInsets(0, 0, 0, 0)
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(PageBg)
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(padding)
                .verticalScroll(scrollState)
                .padding(horizontal = 24.dp)
        ) {
            Spacer(modifier = Modifier.height(34.dp))
            Header()
            Spacer(modifier = Modifier.height(28.dp))

            if (showResetPassword) {
                ResetPasswordSection(
                    username = username,
                    onUsernameChange = { username = it },
                    resetStep = resetStep,
                    resetEmail = resetEmail,
                    onResetEmailChange = { resetEmail = it },
                    resetCode = resetCode,
                    onResetCodeChange = { resetCode = it },
                    resetNewPassword = resetNewPassword,
                    onResetNewPasswordChange = { resetNewPassword = it },
                    resetConfirmPassword = resetConfirmPassword,
                    onResetConfirmPasswordChange = { resetConfirmPassword = it },
                    resetError = resetError,
                    resetInfo = resetInfo,
                    resetLoading = resetLoading,
                    onSubmit = { if (resetStep == "request") doResetRequest() else doResetConfirm() },
                    onBack = {
                        showResetPassword = false
                        resetStep = "request"
                        resetError = ""
                        resetInfo = ""
                    }
                )
            } else {
                ServerConfigHeader(
                    showServerConfig = showServerConfig,
                    onToggle = { showServerConfig = !showServerConfig }
                )

                Spacer(modifier = Modifier.height(8.dp))

                if (showServerConfig) {
                    ServerConfigFields(
                        useHttps = useHttps,
                        onUseHttpsChange = {
                            useHttps = it
                            syncProtocol()
                        },
                        host = host,
                        onHostChange = { host = it },
                        port = port,
                        onPortChange = { port = it },
                        focusManager = focusManager
                    )
                }

                Spacer(modifier = Modifier.height(22.dp))

                LineField(
                    value = username,
                    onValueChange = { username = it },
                    label = "账簿用户名",
                    placeholder = "例如：admin 或 张四",
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) })
                )

                Spacer(modifier = Modifier.height(10.dp))

                LineField(
                    value = password,
                    onValueChange = { password = it },
                    label = "密码",
                    placeholder = "输入密码",
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                imageVector = if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (showPassword) "隐藏密码" else "显示密码",
                                tint = Slate500
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Done
                    ),
                    keyboardActions = KeyboardActions(onDone = { doLogin() })
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    TextButton(
                        onClick = {
                            showResetPassword = true
                            resetStep = "request"
                            resetError = ""
                            resetInfo = ""
                        }
                    ) {
                        Text("找回密码", color = Blue600)
                    }
                }

                Spacer(modifier = Modifier.height(18.dp))

                Button(
                    onClick = { doLogin() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(54.dp),
                    enabled = host.isNotBlank() && username.isNotBlank() && password.isNotBlank(),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Blue600)
                ) {
                    if (uiState is LoginUiState.Testing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            color = Color.White,
                            strokeWidth = 2.dp
                        )
                    } else {
                        Text("登录", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                when (val state = uiState) {
                    is LoginUiState.TestSuccess -> {
                        StatusText("登录成功", SuccessGreen)
                        Spacer(modifier = Modifier.height(10.dp))
                        TextButton(
                            onClick = {
                                viewModel.saveAndConfirm()
                                onLoginSuccess()
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("进入应用", color = Blue600, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        }
                    }

                    is LoginUiState.Error -> StatusText(state.message, MaterialTheme.colorScheme.error)
                    else -> Unit
                }
            }

            Spacer(modifier = Modifier.height(28.dp))
        }
    }
}

@Composable
private fun Header() {
    Column {
        Box(
            modifier = Modifier
                .size(58.dp)
                .clip(CircleShape)
                .background(
                    brush = Brush.linearGradient(colors = listOf(Blue600, Blue500))
                ),
            contentAlignment = Alignment.Center
        ) {
            Text("M", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }

        Spacer(modifier = Modifier.height(18.dp))

        Text(
            text = "登录账簿",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = Slate900
        )
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = "先连接 Web 服务，再用账簿里的用户名和密码登录。",
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = Slate700
        )
    }
}

@Composable
private fun ServerConfigHeader(
    showServerConfig: Boolean,
    onToggle: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "服务地址",
            fontSize = 13.sp,
            color = Slate500,
            modifier = Modifier.weight(1f)
        )
        TextButton(onClick = onToggle) {
            Text(if (showServerConfig) "收起" else "修改", color = Blue600)
        }
    }
}

@Composable
private fun ServerConfigFields(
    useHttps: Boolean,
    onUseHttpsChange: (Boolean) -> Unit,
    host: String,
    onHostChange: (String) -> Unit,
    port: String,
    onPortChange: (String) -> Unit,
    focusManager: androidx.compose.ui.focus.FocusManager
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            LineField(
                value = host,
                onValueChange = onHostChange,
                label = "地址",
                placeholder = "192.168.1.100",
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next
                ),
                keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Right) })
            )

            LineField(
                value = port,
                onValueChange = onPortChange,
                label = "端口",
                placeholder = "7777",
                modifier = Modifier.width(96.dp),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Next
                ),
                keyboardActions = KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Right) })
            )

            Column(
                modifier = Modifier.padding(bottom = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "HTTPS",
                    fontSize = 12.sp,
                    color = Slate500
                )
                Switch(
                    checked = useHttps,
                    onCheckedChange = onUseHttpsChange,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Color.White,
                        checkedTrackColor = Blue600
                    )
                )
            }
        }
    }
}

@Composable
private fun ResetPasswordSection(
    username: String,
    onUsernameChange: (String) -> Unit,
    resetStep: String,
    resetEmail: String,
    onResetEmailChange: (String) -> Unit,
    resetCode: String,
    onResetCodeChange: (String) -> Unit,
    resetNewPassword: String,
    onResetNewPasswordChange: (String) -> Unit,
    resetConfirmPassword: String,
    onResetConfirmPasswordChange: (String) -> Unit,
    resetError: String,
    resetInfo: String,
    resetLoading: Boolean,
    onSubmit: () -> Unit,
    onBack: () -> Unit
) {
    Text("找回密码", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Slate900)
    Spacer(modifier = Modifier.height(2.dp))
    Text(
        text = "按用户名和绑定邮箱重置当前账簿密码。",
        fontSize = 13.sp,
        lineHeight = 18.sp,
        color = Slate700
    )

    Spacer(modifier = Modifier.height(18.dp))

    LineField(
        value = username,
        onValueChange = onUsernameChange,
        label = "账簿用户名",
        placeholder = "输入用户名"
    )

    Spacer(modifier = Modifier.height(10.dp))

    if (resetStep == "request") {
        LineField(
            value = resetEmail,
            onValueChange = onResetEmailChange,
            label = "找回邮箱",
            placeholder = "输入绑定邮箱",
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Done
            )
        )
    } else {
        LineField(
            value = resetCode,
            onValueChange = onResetCodeChange,
            label = "验证码",
            placeholder = "输入邮箱验证码"
        )
        Spacer(modifier = Modifier.height(10.dp))
        LineField(
            value = resetNewPassword,
            onValueChange = onResetNewPasswordChange,
            label = "新密码",
            placeholder = "设置新密码",
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Next
            )
        )
        Spacer(modifier = Modifier.height(10.dp))
        LineField(
            value = resetConfirmPassword,
            onValueChange = onResetConfirmPasswordChange,
            label = "确认密码",
            placeholder = "再次输入新密码",
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Done
            )
        )
    }

    if (resetError.isNotBlank()) {
        Spacer(modifier = Modifier.height(12.dp))
        StatusText(resetError, MaterialTheme.colorScheme.error)
    }
    if (resetInfo.isNotBlank()) {
        Spacer(modifier = Modifier.height(12.dp))
        StatusText(resetInfo, Blue600)
    }

    Spacer(modifier = Modifier.height(20.dp))

    Button(
        onClick = onSubmit,
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp),
        enabled = !resetLoading,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Blue600)
    ) {
        Text(
            text = if (resetStep == "request") {
                if (resetLoading) "发送中..." else "发送验证码"
            } else {
                if (resetLoading) "提交中..." else "重置密码"
            },
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold
        )
    }

    Spacer(modifier = Modifier.height(10.dp))

    TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
        Text("返回登录", color = Slate500)
    }
}

@Composable
private fun LineField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailingIcon: @Composable (() -> Unit)? = null
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = label,
            fontSize = 13.sp,
            color = Slate500
        )
        TextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = {
                Text(
                    text = placeholder,
                    color = Slate300,
                    fontSize = 15.sp
                )
            },
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(
                fontSize = 16.sp,
                color = Slate900,
                fontWeight = FontWeight.Medium
            ),
            visualTransformation = visualTransformation,
            trailingIcon = trailingIcon,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent,
                unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent,
                errorContainerColor = Color.Transparent,
                focusedIndicatorColor = Slate900,
                unfocusedIndicatorColor = Slate300,
                cursorColor = Blue600
            )
        )
    }
}

@Composable
private fun StatusText(
    text: String,
    color: Color
) {
    Text(
        text = text,
        color = color,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
    )
}
