#!/bin/sh
# Inside the boot-test container: boots /w/disk.raw under QEMU with UEFI (OVMF, Secure Boot off) and a network that
# reaches nothing outside, and stops once the image's hygiene check has printed its verdict on the serial port (or
# after the time given). Exits 0 only on "hygiene: ALL PASS".
set -u
limit="${1:-1200}"
cp /usr/share/OVMF/OVMF_VARS_4M.fd /w/vars.fd
: > /w/serial.log
qemu-system-x86_64 -machine q35 -m 1024 -smp 2 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file=/w/vars.fd \
    -drive file=/w/disk.raw,format=raw,if=virtio \
    -nic user,model=virtio-net-pci,restrict=on \
    -display none -monitor none -serial file:/w/serial.log &
qemu=$!
waited=0
while [ "$waited" -lt "$limit" ]; do
    if grep -q "hygiene: ALL PASS\|hygiene: [0-9]* FAILED" /w/serial.log; then break; fi
    if ! kill -0 "$qemu" 2>/dev/null; then break; fi
    sleep 5
    waited=$((waited + 5))
done
kill "$qemu" 2>/dev/null
wait "$qemu" 2>/dev/null
grep "hygiene:" /w/serial.log || echo "no hygiene verdict after ${waited}s"
grep -q "hygiene: ALL PASS" /w/serial.log
