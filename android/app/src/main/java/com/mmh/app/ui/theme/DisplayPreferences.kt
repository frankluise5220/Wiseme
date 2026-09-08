package com.mmh.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.MaterialTheme

private val RedUp = Color(0xFFDC2626)
private val GreenDown = Color(0xFF16A34A)

@Immutable
data class DisplayPreferences(
    val colorScheme: String = "red_up_green_down"
) {
    val upColor: Color
        get() = if (colorScheme == "green_up_red_down") GreenDown else RedUp

    val downColor: Color
        get() = if (colorScheme == "green_up_red_down") RedUp else GreenDown
}

val LocalDisplayPreferences = staticCompositionLocalOf { DisplayPreferences() }

@Composable
fun pnlColor(value: Double): Color {
    val preferences = LocalDisplayPreferences.current
    return when {
        value > 0 -> preferences.upColor
        value < 0 -> preferences.downColor
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}
