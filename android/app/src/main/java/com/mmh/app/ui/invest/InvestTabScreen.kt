package com.mmh.app.ui.invest

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.mmh.app.ui.funds.FundsScreen
import com.mmh.app.ui.regularinvest.RegularInvestListScreen
import kotlinx.coroutines.launch

@Composable
fun InvestTabScreen(
    onNavigateToFundDetail: (accountId: String, fundCode: String) -> Unit = { _, _ -> },
    onNavigateToEntryEdit: (entryId: String) -> Unit = {},
    onNavigateToStockHoldings: (accountId: String) -> Unit = {},
    onNavigateToPropertyAssets: (accountId: String) -> Unit = {}
) {
    val titles = listOf("投资总览", "基金持仓", "定投计划")
    val pagerState = rememberPagerState(pageCount = { titles.size })
    val scope = rememberCoroutineScope()
    var selectedHoldingAccountId by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize()) {
        TabRow(
            selectedTabIndex = pagerState.currentPage,
            containerColor = MaterialTheme.colorScheme.background,
            contentColor = MaterialTheme.colorScheme.primary
        ) {
            titles.forEachIndexed { index, title ->
                Tab(
                    selected = pagerState.currentPage == index,
                    onClick = { scope.launch { pagerState.animateScrollToPage(index) } },
                    text = {
                        Text(
                            text = title,
                            fontSize = 14.sp,
                            fontWeight = if (pagerState.currentPage == index) FontWeight.SemiBold else FontWeight.Medium,
                            color = if (pagerState.currentPage == index) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            }
                        )
                    }
                )
            }
        }

        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
        ) { page ->
            when (page) {
                0 -> InvestOverviewScreen(
                    showTopBar = false,
                    onAccountClick = { accountId, investProductType ->
                        when (investProductType) {
                            "stock" -> onNavigateToStockHoldings(accountId)
                            "property" -> onNavigateToPropertyAssets(accountId)
                            else -> {
                                selectedHoldingAccountId = accountId
                                scope.launch { pagerState.animateScrollToPage(1) }
                            }
                        }
                    }
                )

                1 -> FundsScreen(
                    showTopBar = false,
                    initialSelectedAccountId = selectedHoldingAccountId,
                    onBack = null,
                    onFundClick = onNavigateToFundDetail,
                    onEntryClick = onNavigateToEntryEdit
                )

                2 -> RegularInvestListScreen(showTopBar = false, onBack = null)
            }
        }
    }
}
