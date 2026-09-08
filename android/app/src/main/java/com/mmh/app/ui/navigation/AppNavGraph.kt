package com.mmh.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.mmh.app.ui.login.LoginScreen
import com.mmh.app.ui.main.MainScreen

/**
 * 顶层导航图：LOGIN → MainScreen（底部导航壳）。
 *
 * 所有业务 Tab 和详情页由 MainScreen 内部的 NavHost 管理。
 * 登录成功后跳转到 "main" 路由，退出登录时弹出到 LOGIN。
 */
@Composable
fun AppNavGraph(
    navController: NavHostController,
    isLoggedIn: Boolean,
    startDestination: String = if (isLoggedIn) "main" else NavRoutes.LOGIN
) {
    NavHost(
        navController = navController,
        startDestination = startDestination
    ) {
        composable(NavRoutes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate("main") {
                        popUpTo(NavRoutes.LOGIN) { inclusive = true }
                    }
                }
            )
        }

        composable("main") {
            MainScreen(
                onLogout = {
                    navController.navigate(NavRoutes.LOGIN) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            )
        }
    }
}
