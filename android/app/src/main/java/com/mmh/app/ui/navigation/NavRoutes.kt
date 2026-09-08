package com.mmh.app.ui.navigation

import android.net.Uri

/**
 * Navigation route constants.
 *
 * Bottom tabs:
 * - overview: total summary
 * - accounts: money accounts, including cash, debit cards, third-party wallets, credit cards, loans
 * - statistics: yearly financial statistics (income/expense breakdowns, PnL)
 * - invest: investment overview and holdings
 * - settings: profile/settings
 */
object NavRoutes {
    const val LOGIN = "login"

    const val OVERVIEW = "overview"
    const val ACCOUNTS = "accounts"
    const val STATISTICS = "statistics"
    const val INVEST = "invest"
    const val SETTINGS = "settings"

    const val ACCOUNT_DETAIL = "account_detail/{accountId}/{accountName}"
    const val FUNDS = "funds"
    const val FUND_DETAIL = "fund_detail/{accountId}/{fundCode}"
    const val REGULAR_INVEST = "regular_invest?fundCode={fundCode}"
    const val SERVER_SETTINGS = "server_settings"
    const val TRANSACTION_FORM = "transaction_form"
    const val TRANSACTION_FORM_EDIT = "transaction_form_edit/{entryId}"
    const val STOCK_HOLDINGS = "stock_holdings?accountId={accountId}"
    const val PROPERTY_ASSETS = "property_assets?accountId={accountId}"

    fun accountDetail(accountId: String, accountName: String) = "account_detail/$accountId/$accountName"
    fun transactionForm(
        initialType: String,
        fundSubtype: String = "",
        fundCode: String = "",
        fundName: String = "",
        accountId: String = ""
    ): String {
        return "transaction_form" +
            "?initialType=${Uri.encode(initialType)}" +
            "&fundSubtype=${Uri.encode(fundSubtype)}" +
            "&fundCode=${Uri.encode(fundCode)}" +
            "&fundName=${Uri.encode(fundName)}" +
            "&accountId=${Uri.encode(accountId)}"
    }
    fun transactionFormEdit(entryId: String) = "transaction_form_edit/$entryId"
    fun fundDetail(accountId: String, fundCode: String) = "fund_detail/$accountId/$fundCode"
    fun regularInvest(fundCode: String = "") = "regular_invest?fundCode=$fundCode"
    fun stockHoldings(accountId: String = "") = "stock_holdings?accountId=${Uri.encode(accountId)}"
    fun propertyAssets(accountId: String = "") = "property_assets?accountId=${Uri.encode(accountId)}"
}
