#!/usr/bin/env node

/**
 * BeanPool Version Bumping Utility Script
 *
 * Standalone, zero-dependency Node.js script to increment the version across all
 * workspace package.json files, commit the changes, and create the corresponding Git release tag.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch            # e.g., 1.0.47 -> 1.0.48
 *   node scripts/bump-version.mjs minor            # e.g., 1.0.47 -> 1.1.0
 *   node scripts/bump-version.mjs major            # e.g., 1.0.47 -> 2.0.0
 *   node scripts/bump-version.mjs 1.0.48           # set version explicitly
 *
 * Options:
 *   --dry-run                                      # log changes without writing files or committing
 *   --no-tag                                       # do not create git tag
 *   --no-commit                                    # do not create git commit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Color helpers
const esc = (code) => `\x1b[${code}m`;
const RESET = esc(0);
const BOLD = esc(1);
const GREEN = esc(32);
const YELLOW = esc(33);
const RED = esc(31);
const CYAN = esc(36);
const MAGENTA = esc(35);

const log = (msg) => console.log(msg);
const logSuccess = (msg) => console.log(`${GREEN}✔ ${msg}${RESET}`);
const logWarn = (msg) => console.log(`${YELLOW}⚠ ${msg}${RESET}`);
const logError = (msg) => console.error(`${RED}❌ ${msg}${RESET}`);
const logInfo = (msg) => console.log(`${CYAN}ℹ ${msg}${RESET}`);

// Files to update
const PACKAGE_FILES = [
  'package.json',
  'packages/beanpool-core/package.json',
  'apps/server/package.json',
  'apps/pwa/package.json',
  'apps/native/package.json'
];

function main() {
  log(`\n${BOLD}${CYAN}─────────────────────────────────────────────────────────────${RESET}`);
  log(`  ${BOLD}BeanPool Version Bump Utility${RESET}`);
  log(`${BOLD}${CYAN}─────────────────────────────────────────────────────────────${RESET}\n`);

  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const noTag = args.includes('--no-tag');
  const noCommit = args.includes('--no-commit');
  
  const isNative = args.includes('--native') || args.includes('--native-only');
  const isServer = args.includes('--server') || args.includes('--server-only');
  const mode = isNative ? 'native' : (isServer ? 'server' : 'all');

  if (isNative && isServer) {
    logError("Cannot specify both --native and --server flags.");
    process.exit(1);
  }

  // Filter out options from positional arguments
  const positionalArgs = args.filter(a => !a.startsWith('--'));
  
  if (positionalArgs.length === 0) {
    printHelp();
    process.exit(1);
  }

  const targetArg = positionalArgs[0].toLowerCase();

  // 1. Read current version from the appropriate package
  let currentVersion = '0.0.0';
  
  if (mode === 'native') {
    const appJsonPath = path.resolve(ROOT_DIR, 'apps/native/app.json');
    if (!fs.existsSync(appJsonPath)) {
      logError(`apps/native/app.json not found!`);
      process.exit(1);
    }
    try {
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      currentVersion = appJson.expo?.version || '0.0.0';
    } catch (e) {
      logError(`Failed to parse apps/native/app.json: ${e.message}`);
      process.exit(1);
    }
    logInfo(`[NATIVE MODE] Current version: ${BOLD}${YELLOW}${currentVersion}${RESET}`);
  } else if (mode === 'server') {
    const serverPkgPath = path.resolve(ROOT_DIR, 'apps/server/package.json');
    if (!fs.existsSync(serverPkgPath)) {
      logError(`apps/server/package.json not found!`);
      process.exit(1);
    }
    try {
      const serverPkg = JSON.parse(fs.readFileSync(serverPkgPath, 'utf8'));
      currentVersion = serverPkg.version || '0.0.0';
    } catch (e) {
      logError(`Failed to parse apps/server/package.json: ${e.message}`);
      process.exit(1);
    }
    logInfo(`[SERVER MODE] Current version: ${BOLD}${YELLOW}${currentVersion}${RESET}`);
  } else {
    const rootPkgPath = path.resolve(ROOT_DIR, 'package.json');
    if (!fs.existsSync(rootPkgPath)) {
      logError(`Root package.json not found at: ${rootPkgPath}`);
      process.exit(1);
    }
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      currentVersion = rootPkg.version || '0.0.0';
    } catch (e) {
      logError(`Failed to parse root package.json: ${e.message}`);
      process.exit(1);
    }
    logInfo(`[ALL MONOREPO MODE] Current version: ${BOLD}${YELLOW}${currentVersion}${RESET}`);
  }

  // 2. Parse target version
  let nextVersion;
  if (['patch', 'minor', 'major'].includes(targetArg)) {
    nextVersion = calculateNextVersion(currentVersion, targetArg);
  } else {
    // Verify custom version syntax
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetArg)) {
      logError(`Invalid version format: "${targetArg}". Must be semver (e.g. 1.2.3 or 1.2.3-beta.1).`);
      process.exit(1);
    }
    nextVersion = targetArg;
  }

  if (nextVersion === currentVersion) {
    logWarn(`Proposed version is identical to current version (${nextVersion}).`);
    process.exit(0);
  }

  logInfo(`Target version:  ${BOLD}${GREEN}${nextVersion}${RESET}`);
  if (isDryRun) {
    logWarn(`[DRY RUN] No files will be modified, and no git operations will occur.`);
  }

  log(`\n${BOLD}Updating Package Files:${RESET}`);
  
  // Define files to update based on mode
  let targetPackageFiles = [];
  if (mode === 'native') {
    targetPackageFiles = ['apps/native/package.json'];
  } else if (mode === 'server') {
    targetPackageFiles = [
      'package.json',
      'packages/beanpool-core/package.json',
      'apps/server/package.json',
      'apps/pwa/package.json'
    ];
  } else {
    targetPackageFiles = [
      'package.json',
      'packages/beanpool-core/package.json',
      'apps/server/package.json',
      'apps/pwa/package.json',
      'apps/native/package.json'
    ];
  }

  // 3. Update version in files
  const updatedFilesPaths = [];
  for (const relPath of targetPackageFiles) {
    const fullPath = path.resolve(ROOT_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
      logWarn(`File not found, skipping: ${relPath}`);
      continue;
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (e) {
      logError(`Failed to parse ${relPath}: ${e.message}`);
      process.exit(1);
    }

    const prevVersion = pkg.version || 'none';
    
    if (isDryRun) {
      log(`   ${relPath}: ${YELLOW}${prevVersion}${RESET} → ${GREEN}${nextVersion}${RESET} (dry-run)`);
    } else {
      pkg.version = nextVersion;
      fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      log(`   ${relPath}: ${YELLOW}${prevVersion}${RESET} → ${GREEN}${nextVersion}${RESET} ${GREEN}✔${RESET}`);
      updatedFilesPaths.push(fullPath);
    }
  }

  // 3.5. Update apps/native/app.json if in native or all mode
  if (mode === 'native' || mode === 'all') {
    const appJsonPath = path.resolve(ROOT_DIR, 'apps/native/app.json');
    if (fs.existsSync(appJsonPath)) {
      try {
        const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
        if (appJson.expo) {
          const prevVer = appJson.expo.version;
          appJson.expo.version = nextVersion;
          
          let prevBuild = 'unknown';
          if (appJson.expo.ios && appJson.expo.ios.buildNumber) {
            prevBuild = appJson.expo.ios.buildNumber;
            const nextBuildNum = parseInt(appJson.expo.ios.buildNumber, 10) + 1;
            appJson.expo.ios.buildNumber = String(nextBuildNum);
          }
          if (appJson.expo.android && appJson.expo.android.versionCode) {
            appJson.expo.android.versionCode = parseInt(appJson.expo.android.versionCode, 10) + 1;
          }
          
          if (!isDryRun) {
            fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
            log(`   apps/native/app.json: ${YELLOW}${prevVer} (Build ${prevBuild})${RESET} → ${GREEN}${nextVersion} (Build ${appJson.expo.ios.buildNumber})${RESET} ${GREEN}✔${RESET}`);
            updatedFilesPaths.push(appJsonPath);
          } else {
            log(`   apps/native/app.json: ${YELLOW}${prevVer} (Build ${prevBuild})${RESET} → ${GREEN}${nextVersion} (Build ${appJson.expo.ios.buildNumber})${RESET} (dry-run)`);
          }
        }
      } catch (e) {
        logError(`Failed to update apps/native/app.json: ${e.message}`);
      }
    }
  }

  // 3.6. Update apps/server/src/state-engine.ts if in server or all mode
  if (mode === 'server' || mode === 'all') {
    const stateEnginePath = path.resolve(ROOT_DIR, 'apps/server/src/state-engine.ts');
    if (fs.existsSync(stateEnginePath)) {
      try {
        let content = fs.readFileSync(stateEnginePath, 'utf8');
        const versionRegex = /version:\s*'([^']+)'/;
        const match = content.match(versionRegex);
        if (match) {
          const prevVer = match[1];
          if (!isDryRun) {
            content = content.replace(versionRegex, `version: '${nextVersion}'`);
            fs.writeFileSync(stateEnginePath, content, 'utf8');
            log(`   apps/server/src/state-engine.ts: version: ${YELLOW}'${prevVer}'${RESET} → ${GREEN}'${nextVersion}'${RESET} ${GREEN}✔${RESET}`);
            updatedFilesPaths.push(stateEnginePath);
          } else {
            log(`   apps/server/src/state-engine.ts: version: ${YELLOW}'${prevVer}'${RESET} → ${GREEN}'${nextVersion}'${RESET} (dry-run)`);
          }
        }
      } catch (e) {
        logError(`Failed to update apps/server/src/state-engine.ts: ${e.message}`);
      }
    }
  }

  if (isDryRun) {
    logSuccess(`\n[DRY RUN SUCCESS] All package versions parsed cleanly.`);
    log(`Next steps without --dry-run:`);
    log(`  1. Write versions to files`);
    const filesToStage = updatedFilesPaths.map(p => path.relative(ROOT_DIR, p));
    if (!noCommit) log(`  2. Run: git add ${filesToStage.join(' ')}`);
    
    const commitMsg = mode === 'native' ? `chore(native): bump version to v${nextVersion}`
                    : mode === 'server' ? `chore(server): bump version to v${nextVersion}`
                    : `chore: bump version to v${nextVersion}`;
    const tagName = mode === 'native' ? `native-v${nextVersion}`
                  : mode === 'server' ? `server-v${nextVersion}`
                  : `v${nextVersion}`;
                  
    if (!noCommit) log(`  3. Run: git commit -m "${commitMsg}"`);
    if (!noTag) log(`  4. Run: git tag ${tagName}`);
    log(`  5. Run: git push && git push --tags`);
    process.exit(0);
  }

  logSuccess(`\nAll version targets updated to v${nextVersion}!`);

  // 4. Git Operations
  if (noCommit) {
    logInfo('Skipping git commit as requested (--no-commit).');
    process.exit(0);
  }

  // Check if git is available and tree status
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    logWarn('Not in a git repository. Git operations skipped.');
    process.exit(0);
  }

  log(`\n${BOLD}Git Operations:${RESET}`);
  try {
    // Stage all updated files
    const relPathsToStage = updatedFilesPaths.map(p => path.relative(ROOT_DIR, p));
    execSync(`git add ${relPathsToStage.join(' ')}`, { cwd: ROOT_DIR });
    log(`   git add updated files... ${GREEN}✔${RESET}`);

    // Commit
    const commitMsg = mode === 'native' ? `chore(native): bump version to v${nextVersion}`
                    : mode === 'server' ? `chore(server): bump version to v${nextVersion}`
                    : `chore: bump version to v${nextVersion}`;
    execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT_DIR, stdio: 'ignore' });
    log(`   git commit -m "${commitMsg}"... ${GREEN}✔${RESET}`);

    if (noTag) {
      logInfo('Skipping git release tag as requested (--no-tag).');
    } else {
      // Tag
      const tagName = mode === 'native' ? `native-v${nextVersion}`
                    : mode === 'server' ? `server-v${nextVersion}`
                    : `v${nextVersion}`;
      // Remove tag first if it exists locally to avoid conflict
      try {
        execSync(`git tag -d ${tagName}`, { cwd: ROOT_DIR, stdio: 'ignore' });
      } catch { /* normal if tag doesn't exist */ }

      execSync(`git tag -a ${tagName} -m "Release ${tagName}"`, { cwd: ROOT_DIR, stdio: 'ignore' });
      log(`   git tag -a ${tagName}... ${GREEN}✔${RESET}`);
    }

    log(`\n${BOLD}${GREEN}🎉 Version bump successful!${RESET}`);
    if (mode === 'server' || mode === 'all') {
      log(`To trigger the build & push Docker image, run:`);
      log(`  ${BOLD}git push && git push --tags${RESET}\n`);
    } else {
      log(`Git tag is ready. To push native release tag, run:`);
      log(`  ${BOLD}git push && git push --tags${RESET}\n`);
    }

  } catch (e) {
    logError(`Git operation failed: ${e.message}`);
    logWarn('Please verify git status and manually complete commit or tagging.');
  }
}

function calculateNextVersion(current, releaseType) {
  const parts = current.split('-')[0].split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    logError(`Cannot auto-bump non-standard semver: "${current}". Please pass explicit version.`);
    process.exit(1);
  }

  let [major, minor, patch] = parts;

  if (releaseType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (releaseType === 'minor') {
    minor += 1;
    patch = 0;
  } else if (releaseType === 'patch') {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function printHelp() {
  log(`Usage:`);
  log(`  node scripts/bump-version.mjs <increment_type|version> [options]`);
  log(``);
  log(`Increment Types:`);
  log(`  patch                 Increments the patch version (e.g. 1.0.47 -> 1.0.48)`);
  log(`  minor                 Increments the minor version (e.g. 1.0.47 -> 1.1.0)`);
  log(`  major                 Increments the major version (e.g. 1.0.47 -> 2.0.0)`);
  log(``);
  log(`Explicit Version:`);
  log(`  1.0.48                Bumps all target files to exactly "1.0.48"`);
  log(``);
  log(`Options:`);
  log(`  --native, --native-only  Only bump companion app versions (apps/native/package.json & app.json)`);
  log(`  --server, --server-only  Only bump backend server nodes (package.json, apps/server, core, pwa, state-engine)`);
  log(`  --dry-run                Preview changes without modifying files or running git`);
  log(`  --no-tag                 Skip creating a git tag (only updates files and commits)`);
  log(`  --no-commit              Skip git commit and tag (only modifies files)`);
  log(``);
  log(`Examples:`);
  log(`  node scripts/bump-version.mjs patch --native`);
  log(`  node scripts/bump-version.mjs 1.1.0 --server --dry-run`);
}

main();
