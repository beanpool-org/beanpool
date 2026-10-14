#!/bin/sh
# Runs a command in a network namespace of its own with only loopback up, so nothing it starts can reach another host
# (no BeanPool node, registrar, store or DNS): a load test against a server on 127.0.0.1 and nothing else. Linux, as root
# (or with unprivileged user namespaces: add --map-root-user). Loopback is brought up with one ioctl, so `ip` isn't needed.
exec unshare --net sh -c '
python3 -c "
import socket, fcntl, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack(\"16sH\", fcntl.ioctl(s, 0x8913, struct.pack(\"16sH\", b\"lo\", 0)))[1]
fcntl.ioctl(s, 0x8914, struct.pack(\"16sH\", b\"lo\", flags | 1))
" && exec "$@"' sh "$@"
