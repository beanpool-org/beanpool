package org.beanpool.navbarcolour

import android.os.Build
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The navigation bar's colour on Android 8 and 9 (API 26 to 28), from the theme the app is drawn in (index.ts).
 *
 * React Native draws the app edge to edge (WindowUtil.enableEdgeToEdge). From Android 10 the bar is see-through. Below it,
 * it paints a 90 % white bar unless the PHONE is in its night mode, which Android 8 doesn't have: a light grey bar over a
 * dark page, the page's words showing through behind white buttons (walk 148). Here the bar takes the app's own colour.
 *
 * Kept, and painted again when the app comes back: a window made anew starts with React Native's colour.
 */
class NavBarColourModule : Module() {
  private var colour: Int? = null

  override fun definition() = ModuleDefinition {
    Name("BeanPoolNavBarColour")

    AsyncFunction("set") { argb: Int ->
      colour = argb
      paint()
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      paint()
    }
  }

  @Suppress("DEPRECATION")
  private fun paint() {
    val argb = colour ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return
    appContext.currentActivity?.window?.navigationBarColor = argb
  }
}
