package com.mmh.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.navigation.compose.rememberNavController
import com.mmh.app.data.local.TokenProvider
import com.mmh.app.ui.navigation.AppNavGraph
import com.mmh.app.ui.theme.MMHTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/**
 * Main entry point of the MMH Android client.
 *
 * Checks if the user has completed username/password login for a saved server address.
 * If yes, navigates directly to overview; otherwise shows login screen.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var tokenProvider: TokenProvider

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            val navController = rememberNavController()
            val isLoggedIn by tokenProvider::isConnectedState
            val displayColorScheme by tokenProvider::colorSchemeState

            MMHTheme(displayColorScheme = displayColorScheme) {
                AppNavGraph(
                    navController = navController,
                    isLoggedIn = isLoggedIn
                )
            }
        }
    }
}
