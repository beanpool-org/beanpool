import Darwin
import ExpoModulesCore

/// The phone's since-boot clock, for App Lock (apps/native/utils/app-lock-clock.ts): milliseconds since the phone
/// started, counting the time it slept (mach_continuous_time). Setting the date and time in Settings doesn't move it.
/// Not mach_absolute_time or ProcessInfo.systemUptime, which stop while the phone sleeps, and not CLOCK_MONOTONIC, which
/// Darwin works out from the wall clock (gettimeofday minus the boot time).
public class BootClockModule: Module {
  private static let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
  }()

  public func definition() -> ModuleDefinition {
    Name("BeanPoolBootClock")

    Function("elapsedMs") { () -> Double in
      let timebase = BootClockModule.timebase
      return Double(mach_continuous_time()) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000
    }
  }
}
