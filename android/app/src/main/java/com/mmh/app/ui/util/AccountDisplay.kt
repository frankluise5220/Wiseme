package com.mmh.app.ui.util

fun formatAccountDisplayName(name: String, institutionName: String?): String {
    val account = name.trim()
    val institution = institutionName?.trim().orEmpty()
    if (institution.isBlank()) return account
    if (account.isBlank()) return institution
    if (account == institution || account.startsWith("$institution·")) return account
    return "$institution·$account"
}
