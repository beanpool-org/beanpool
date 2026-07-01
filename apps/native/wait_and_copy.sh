#!/bin/bash
PID=$(cat build_android.pid)
echo "Waiting for build process $PID to finish..." >> build_android.log
wait $PID
echo "Build process finished. Moving artifacts..." >> build_android.log
mv *.apk /Users/marty/projects/beanpool/builds/ 2>/dev/null
mv *.aab /Users/marty/projects/beanpool/builds/ 2>/dev/null
echo "Done." >> build_android.log
