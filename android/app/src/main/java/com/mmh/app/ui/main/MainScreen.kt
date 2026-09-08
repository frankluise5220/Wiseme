package com.mmh.app.ui.main

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.TrendingUp
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.mmh.app.ui.accounts.AccountsScreen
import com.mmh.app.ui.funddetail.FundDetailScreen
import com.mmh.app.ui.funds.FundsScreen
import com.mmh.app.ui.invest.InvestTabScreen
import com.mmh.app.ui.navigation.NavRoutes
import com.mmh.app.ui.statistics.StatisticsScreen
import com.mmh.app.ui.overview.OverviewScreen
import com.mmh.app.ui.regularinvest.RegularInvestListScreen
import com.mmh.app.ui.property.PropertyAssetsScreen
import com.mmh.app.ui.settings.ServerSettingsScreen
import com.mmh.app.ui.settings.SettingsScreen
import com.mmh.app.ui.stocks.StockHoldingsScreen
import com.mmh.app.ui.transactions.TransactionFormScreen
import com.mmh.app.ui.transactions.TransactionListScreen

@Composable
fun MainScreen(
    onLogout: () -> Unit,
    viewModel: MainViewModel = hiltViewModel()
) {
    val navController = rememberNavController()
    val snackbarHostState = remember { SnackbarHostState() }

    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val showBottomBar = currentRoute in TAB_ROUTES

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            if (showBottomBar) {
                MainBottomBar(
                    currentRoute = currentRoute,
                    onRecordClick = {
                        navController.navigate(NavRoutes.transactionForm(recordTypeForRoute(currentRoute)))
                    },
                    onTabClick = { route ->
                        if (currentRoute != route) {
                            navController.navigate(route) {
                                popUpTo(NavRoutes.OVERVIEW) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    }
                )
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = NavRoutes.OVERVIEW,
            modifier = Modifier.padding(innerPadding),
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None }
        ) {
            composable(NavRoutes.OVERVIEW) {
                OverviewScreen(
                    onNavigateToSettings = { navController.navigate(NavRoutes.SETTINGS) },
                    onNavigateToAccounts = { navController.navigate(NavRoutes.ACCOUNTS) },
                    onNavigateToFunds = { navController.navigate(NavRoutes.FUNDS) },
                    onNavigateToAddTransaction = {
                        navController.navigate(NavRoutes.transactionForm("expense"))
                    },
                    onNavigateToAccountDetail = { accountId, accountName ->
                        navController.navigate(NavRoutes.accountDetail(accountId, accountName))
                    }
                )
            }

            composable(NavRoutes.ACCOUNTS) {
                AccountsScreen(
                    onAccountClick = { accountId, accountName ->
                        navController.navigate(NavRoutes.accountDetail(accountId, accountName))
                    }
                )
            }

            composable(NavRoutes.STATISTICS) {
                StatisticsScreen()
            }

            composable(NavRoutes.INVEST) {
                InvestTabScreen(
                    onNavigateToFundDetail = { accountId, fundCode ->
                        navController.navigate(NavRoutes.fundDetail(accountId, fundCode))
                    },
                    onNavigateToEntryEdit = { entryId ->
                        navController.navigate(NavRoutes.transactionFormEdit(entryId))
                    },
                    onNavigateToStockHoldings = { accountId ->
                        navController.navigate(NavRoutes.stockHoldings(accountId))
                    },
                    onNavigateToPropertyAssets = { accountId ->
                        navController.navigate(NavRoutes.propertyAssets(accountId))
                    }
                )
            }

            composable(NavRoutes.SETTINGS) {
                SettingsScreen(
                    onNavigateToServerSettings = { navController.navigate(NavRoutes.SERVER_SETTINGS) }
                )
            }

            composable(NavRoutes.SERVER_SETTINGS) {
                ServerSettingsScreen(
                    onBack = { navController.popBackStack() },
                    onLogout = onLogout
                )
            }

            composable(
                route = NavRoutes.STOCK_HOLDINGS,
                arguments = listOf(
                    navArgument("accountId") {
                        type = NavType.StringType
                        defaultValue = ""
                    }
                )
            ) { backStackEntry ->
                val accountId = backStackEntry.arguments?.getString("accountId") ?: ""
                StockHoldingsScreen(
                    accountId = accountId,
                    showTopBar = true,
                    onBack = { navController.popBackStack() }
                )
            }

            composable(
                route = NavRoutes.PROPERTY_ASSETS,
                arguments = listOf(
                    navArgument("accountId") {
                        type = NavType.StringType
                        defaultValue = ""
                    }
                )
            ) { backStackEntry ->
                val accountId = backStackEntry.arguments?.getString("accountId") ?: ""
                PropertyAssetsScreen(
                    accountId = accountId,
                    showTopBar = true,
                    onBack = { navController.popBackStack() }
                )
            }

            composable(
                route = NavRoutes.ACCOUNT_DETAIL,
                arguments = listOf(
                    navArgument("accountId") { type = NavType.StringType },
                    navArgument("accountName") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val accountId = backStackEntry.arguments?.getString("accountId") ?: ""
                val accountName = backStackEntry.arguments?.getString("accountName") ?: ""
                TransactionListScreen(
                    accountId = accountId,
                    accountName = accountName,
                    onBack = { navController.popBackStack() },
                    onNavigateToCreate = { initialType ->
                        navController.navigate(NavRoutes.transactionForm(initialType))
                    },
                    onEditTransaction = { transactionId ->
                        navController.navigate(NavRoutes.transactionFormEdit(transactionId))
                    }
                )
            }

            composable(NavRoutes.FUNDS) {
                FundsScreen(
                    onBack = { navController.popBackStack() },
                    onFundClick = { accountId, fundCode ->
                        navController.navigate(NavRoutes.fundDetail(accountId, fundCode))
                    },
                    onEntryClick = { entryId ->
                        navController.navigate(NavRoutes.transactionFormEdit(entryId))
                    }
                )
            }

            composable(
                route = NavRoutes.REGULAR_INVEST,
                arguments = listOf(
                    navArgument("fundCode") {
                        type = NavType.StringType
                        defaultValue = ""
                    }
                )
            ) { backStackEntry ->
                val fundCode = backStackEntry.arguments?.getString("fundCode") ?: ""
                RegularInvestListScreen(
                    showTopBar = true,
                    onBack = { navController.popBackStack() },
                    filterFundCode = fundCode
                )
            }

            composable(
                route = NavRoutes.FUND_DETAIL,
                arguments = listOf(
                    navArgument("accountId") { type = NavType.StringType },
                    navArgument("fundCode") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val accountId = backStackEntry.arguments?.getString("accountId") ?: ""
                val fundCode = backStackEntry.arguments?.getString("fundCode") ?: ""
                FundDetailScreen(
                    accountId = accountId,
                    fundCode = fundCode,
                    onBack = { navController.popBackStack() },
                    onEntryEdit = { entryId -> 
                        navController.navigate(NavRoutes.transactionFormEdit(entryId))
                    },
                    onBuyClick = { fundName ->
                        navController.navigate(
                            NavRoutes.transactionForm(
                                initialType = "investment",
                                fundSubtype = "buy",
                                fundCode = fundCode,
                                fundName = fundName,
                                accountId = accountId
                            )
                        )
                    },
                    onSellClick = { fundName ->
                        navController.navigate(
                            NavRoutes.transactionForm(
                                initialType = "investment",
                                fundSubtype = "redeem",
                                fundCode = fundCode,
                                fundName = fundName,
                                accountId = accountId
                            )
                        )
                    },
                    onRegularInvestClick = {
                        navController.navigate(NavRoutes.regularInvest(fundCode))
                    }
                )
            }

            composable(
                route = "transaction_form?initialType={initialType}&fundSubtype={fundSubtype}&fundCode={fundCode}&fundName={fundName}&accountId={accountId}",
                arguments = listOf(
                    navArgument("initialType") {
                        type = NavType.StringType
                        defaultValue = "expense"
                    },
                    navArgument("fundSubtype") {
                        type = NavType.StringType
                        defaultValue = ""
                    },
                    navArgument("fundCode") {
                        type = NavType.StringType
                        defaultValue = ""
                    },
                    navArgument("fundName") {
                        type = NavType.StringType
                        defaultValue = ""
                    },
                    navArgument("accountId") {
                        type = NavType.StringType
                        defaultValue = ""
                    }
                )
            ) { backStackEntry ->
                val initialType = backStackEntry.arguments?.getString("initialType") ?: "expense"
                val fundSubtype = backStackEntry.arguments?.getString("fundSubtype") ?: ""
                val fundCode = backStackEntry.arguments?.getString("fundCode") ?: ""
                val fundName = backStackEntry.arguments?.getString("fundName") ?: ""
                val accountId = backStackEntry.arguments?.getString("accountId") ?: ""
                TransactionFormScreen(
                    initialType = initialType,
                    initialFundSubtype = fundSubtype,
                    initialFundCode = fundCode,
                    initialFundName = fundName,
                    initialAccountId = accountId,
                    onBack = { navController.popBackStack() },
                    onSaved = { navController.popBackStack() }
                )
            }

            composable(
                route = NavRoutes.TRANSACTION_FORM_EDIT,
                arguments = listOf(
                    navArgument("entryId") { type = NavType.StringType }
                )
            ) { backStackEntry ->
                val entryId = backStackEntry.arguments?.getString("entryId") ?: ""
                TransactionFormScreen(
                    entryId = entryId,
                    onBack = { navController.popBackStack() },
                    onSaved = { navController.popBackStack() }
                )
            }
        }
    }
}

private data class TabItem(val label: String, val icon: ImageVector, val route: String)

private val TAB_ITEMS = listOf(
    TabItem("总览", Icons.Default.Home, NavRoutes.OVERVIEW),
    TabItem("账户", Icons.Default.AccountBalanceWallet, NavRoutes.ACCOUNTS),
    TabItem("投资", Icons.AutoMirrored.Filled.TrendingUp, NavRoutes.INVEST),
    TabItem("我的", Icons.Default.Person, NavRoutes.SETTINGS),
)

private val TAB_ROUTES = setOf(
    NavRoutes.OVERVIEW,
    NavRoutes.ACCOUNTS,
    NavRoutes.STATISTICS,
    NavRoutes.INVEST,
    NavRoutes.SETTINGS,
)

private fun recordTypeForRoute(route: String?): String {
    return when (route) {
        NavRoutes.INVEST -> "investment"
        else -> "expense"
    }
}

@Composable
private fun MainBottomBar(
    currentRoute: String?,
    onRecordClick: () -> Unit,
    onTabClick: (String) -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(92.dp),
        contentAlignment = Alignment.TopCenter
    ) {
        NavigationBar(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .height(72.dp),
            containerColor = MaterialTheme.colorScheme.surface
        ) {
            TAB_ITEMS.take(2).forEach { item ->
                MainNavigationItem(item = item, selected = currentRoute == item.route, onClick = onTabClick)
            }

            Spacer(Modifier.weight(0.72f))

            TAB_ITEMS.drop(2).forEach { item ->
                MainNavigationItem(item = item, selected = currentRoute == item.route, onClick = onTabClick)
            }
        }

        Surface(
            modifier = Modifier.size(76.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 3.dp,
            shadowElevation = 6.dp
        ) {}

        FloatingActionButton(
            onClick = onRecordClick,
            modifier = Modifier
                .size(60.dp)
                .offset(y = 3.dp),
            shape = CircleShape,
            containerColor = MaterialTheme.colorScheme.primary,
            elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 8.dp)
        ) {
            Icon(Icons.Default.Add, contentDescription = "\u8bb0\u4e00\u7b14", tint = MaterialTheme.colorScheme.onPrimary)
        }
    }
}

@Composable
private fun RowScope.MainNavigationItem(
    item: TabItem,
    selected: Boolean,
    onClick: (String) -> Unit
) {
    NavigationBarItem(
        icon = { Icon(item.icon, contentDescription = item.label) },
        label = { Text(item.label) },
        selected = selected,
        onClick = { onClick(item.route) }
    )
}
