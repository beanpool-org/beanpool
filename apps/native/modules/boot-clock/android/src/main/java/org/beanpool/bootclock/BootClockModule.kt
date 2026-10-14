package org.beanpool.bootclock

import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The phone's since-boot clock, for App Lock (apps/native/utils/app-lock-clock.ts): milliseconds since the phone started,
 * counting deep sleep (SystemClock.elapsedRealtime, CLOCK_BOOTTIME). Setting the date and time in the phone's Settings
 * doesn't move it. Not uptimeMillis or System.nanoTime (CLOCK_MONOTONIC, which JS's performance.now reads): those stop
 * while the phone is in deep sleep.
 */
class BootClockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BeanPoolBootClock")

    Function("elapsedMs") {
      SystemClock.elapsedRealtime().toDouble()
    }
  }
}
