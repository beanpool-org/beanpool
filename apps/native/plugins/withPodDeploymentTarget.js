// Xcode 27 refuses a pod target below iOS 15 ("error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 9.0,
// but the range of supported deployment target versions is 15.0 to 27.1.x"): SDWebImage, GoogleSignIn, AppAuth, GTM*, RNSVG,
// AsyncStorage and others still declare 9.0–13.4, and the archive fails (18 Oct 2026, 1.2.67's first iPhone build on 27.1).
// Raise every pod target, resource bundles included, to the app's own minimum in the Podfile's post_install, after
// react_native_post_install. A target that already asks for more keeps its own.
const { withPodfile } = require('expo/config-plugins');

const MARK = '# withPodDeploymentTarget';

function addHook(contents, minimum) {
  if (contents.includes(MARK)) return contents;
  const call = /(\n([ \t]*)react_native_post_install\([\s\S]*?\n\2\))/;
  if (!call.test(contents)) throw new Error('withPodDeploymentTarget: no react_native_post_install(...) in the Podfile');
  const hook = (indent) => [
    '',
    `${indent}${MARK}: Xcode 27 refuses pod targets below iOS 15.`,
    `${indent}(installer.pods_project.targets + installer.pod_target_subprojects.flat_map(&:targets)).each do |t|`,
    `${indent}  t.build_configurations.each do |c|`,
    `${indent}    current = c.build_settings['IPHONEOS_DEPLOYMENT_TARGET']`,
    `${indent}    if current.nil? || Gem::Version.new(current) < Gem::Version.new('${minimum}')`,
    `${indent}      c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${minimum}'`,
    `${indent}    end`,
    `${indent}  end`,
    `${indent}end`,
  ].join('\n');
  return contents.replace(call, (m, _whole, indent) => m + hook(indent));
}

module.exports = function withPodDeploymentTarget(config, { minimum = '15.1' } = {}) {
  return withPodfile(config, (config) => {
    config.modResults.contents = addHook(config.modResults.contents, minimum);
    return config;
  });
};
module.exports.addHook = addHook;
