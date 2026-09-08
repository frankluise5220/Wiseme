package com.mmh.app.ui.util

import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * 全局格式化工具。
 * 所有屏幕统一使用此模块，禁止在各屏幕内重复定义格式化函数。
 */

/** 金额 → CNY 字符串，负数带前导负号 */
fun formatAmount(amount: Double): String {
    val abs = kotlin.math.abs(amount)
    val formatted = String.format("¥%.2f", abs)
    return if (amount < 0) "-$formatted" else formatted
}

/** 盈亏带正负号（正数补 "+"） */
fun formatPnl(amount: Double): String {
    val sign = if (amount > 0) "+" else ""
    return sign + formatAmount(amount)
}

/** 百分比率（如 2.34%） */
fun formatRate(rate: Double): String = String.format("%.2f%%", rate * 100)

/** ISO 日期 → 简洁显示：今天 / 昨天 / M月d日 / yyyy年M月d日 */
fun formatDateRelative(iso: String): String {
    if (iso.isBlank()) return "—"
    return try {
        val dateStr = iso.substringBefore("T").ifBlank { iso }
        val date = LocalDate.parse(dateStr)
        val today = LocalDate.now()
        val yesterday = today.minusDays(1)
        when {
            date == today -> "今天"
            date == yesterday -> "昨天"
            date.year == today.year -> date.format(DateTimeFormatter.ofPattern("M月d日"))
            else -> date.format(DateTimeFormatter.ofPattern("yyyy年M月d日"))
        }
    } catch (e: Exception) {
        iso.substringBefore("T")
    }
}

/** ISO 日期 → YYYY-MM-DD */
fun formatDate(iso: String): String {
    if (iso.isBlank()) return "—"
    val d = iso.substringBefore("T").ifBlank { iso }
    return if (d.length >= 10) d.substring(0, 10) else d
}
