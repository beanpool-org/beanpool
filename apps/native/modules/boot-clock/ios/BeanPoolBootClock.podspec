Pod::Spec.new do |s|
  s.name           = 'BeanPoolBootClock'
  s.version        = '1.0.0'
  s.summary        = "The phone's since-boot clock, counting sleep, for App Lock"
  s.description    = "The phone's since-boot clock (mach_continuous_time), counting sleep, for BeanPool's App Lock"
  s.license        = 'MIT'
  s.author         = 'BeanPool'
  s.homepage       = 'https://beanpool.org'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
