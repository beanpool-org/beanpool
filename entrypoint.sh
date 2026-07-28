#!/bin/sh
set -e

# If running as root, we drop privileges using PUID/PGID
if [ "$(id -u)" = "0" ]; then
  PUID=${PUID:-1000}
  PGID=${PGID:-1000}
  
  # Ensure the data directory is owned by the requested user
  chown -R $PUID:$PGID /data

  # Allow the unprivileged process group to access the Docker API socket
  if [ -S /var/run/docker.sock ]; then
    chown root:$PGID /var/run/docker.sock || true
    chmod 660 /var/run/docker.sock || true
  fi
  
  # Drop privileges and execute the main process
  exec su-exec $PUID:$PGID "$@"
else
  # If already running as a non-root user (e.g., forced by TrueNAS/Kubernetes), 
  # we assume the volume permissions are already correct and execute directly.
  exec "$@"
fi
