#!/bin/bash
# Basic Maestro smoke pass for the native app, run by hand before eas build --local.
# Not run in CI: it needs a live emulator/device with an already-joined identity.
# See apps/native/e2e/README.md for setup and what each flow covers.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$REPO_ROOT/apps/native/e2e"

MAESTRO_BIN="maestro"
if ! command -v maestro > /dev/null 2>&1; then
    if [ -x "$HOME/.maestro/bin/maestro" ]; then
        MAESTRO_BIN="$HOME/.maestro/bin/maestro"
    else
        echo "maestro CLI not found on PATH or in ~/.maestro/bin — see apps/native/e2e/README.md" >&2
        exit 1
    fi
fi

export MAESTRO_CLI_NO_ANALYTICS="${MAESTRO_CLI_NO_ANALYTICS:-1}"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED="${MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED:-true}"

if ! command -v adb > /dev/null 2>&1; then
    echo "adb not found on PATH — Android SDK platform-tools required" >&2
    exit 1
fi

DEVICE_LINE="$(adb devices | grep -w device || true)"
if [ -z "$DEVICE_LINE" ]; then
    echo "No emulator or device attached (adb devices shows none) — start one first" >&2
    exit 1
fi

APP_ID="org.beanpool.pillar"
if ! adb shell pm list packages | grep -q "$APP_ID"; then
    echo "App not installed on the device ($APP_ID) — run npx expo run:android first" >&2
    exit 1
fi

if [ ! -d "$E2E_DIR" ]; then
    echo "No e2e directory at $E2E_DIR" >&2
    exit 1
fi

FLOW_COUNT=0
FAIL_COUNT=0

for flow in "$E2E_DIR"/*.yaml; do
    [ -e "$flow" ] || continue
    FLOW_COUNT=$((FLOW_COUNT + 1))
    name="$(basename "$flow")"
    log_file="/tmp/maestro-prerelease-${name%.yaml}.log"
    if "$MAESTRO_BIN" test "$flow" > "$log_file" 2>&1; then
        echo "PASS  $name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "FAIL  $name — see $log_file"
    fi
done

if [ "$FLOW_COUNT" -eq 0 ]; then
    echo "No flows found in $E2E_DIR" >&2
    exit 1
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "$FAIL_COUNT of $FLOW_COUNT flows failed"
    exit 1
fi

echo "All $FLOW_COUNT flows passed"
