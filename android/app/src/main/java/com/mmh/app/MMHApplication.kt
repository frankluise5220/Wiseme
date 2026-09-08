package com.mmh.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

/**
 * MMH Application class.
 * Entry point for Hilt dependency injection.
 */
@HiltAndroidApp
class MMHApplication : Application()