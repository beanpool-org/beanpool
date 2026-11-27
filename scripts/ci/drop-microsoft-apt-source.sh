#!/usr/bin/env bash
# Remove unused Microsoft apt sources (packages.microsoft.com) from a GitHub-hosted
# Ubuntu runner before `apt-get update` / `apt-get install` or `playwright install --with-deps`.
#
# Why: on ubuntu-latest (Ubuntu 26.04 Resolute), Microsoft's preinstalled apt source
# periodically returns 403 Forbidden / "is no longer signed", breaking unrelated apt steps
# (runs 45902660908, 45904327711, 45911874913). None of our workflows install Microsoft
# packages (powershell, dotnet, azure-cli).
#
# Safety: only removes *.list and *.sources files inside APT_SOURCES_DIR whose active
# (non-comment) URIs are EXCLUSIVELY on packages.microsoft.com. Never removes Ubuntu's
# own sources, comments-only matches, or mixed-URI files.
#
# Env:
#   APT_SOURCES_DIR  override /etc/apt/sources.list.d (for tests)
set -euo pipefail

dir="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
if [ ! -d "$dir" ]; then
  exit 0
fi

# Returns 0 iff the .list file has >= 1 active apt URI and EVERY active line/URI points to packages.microsoft.com.
is_only_microsoft_list() {
  awk '
    BEGIN { ms = 0; other = 0 }
    {
      line = $0
      sub(/#.*/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (line == "") next
      if (line !~ /^deb(-src)?[[:space:]]+/) { other++; next }
      sub(/^deb(-src)?[[:space:]]+/, "", line)
      if (line ~ /^\[/) {
        if (line !~ /^\[[^]]*\][[:space:]]+/) { other++; next }
        sub(/^\[[^]]*\][[:space:]]+/, "", line)
      }
      split(line, parts, /[[:space:]]+/)
      uri = tolower(parts[1])
      if (uri ~ /^https?:\/\/packages\.microsoft\.com(\/|$)/) ms++
      else other++
    }
    END { exit (ms > 0 && other == 0) ? 0 : 1 }
  ' "$1"
}

# Returns 0 iff the DEB822 .sources file has >= 1 active URIs entry and EVERY URI points to packages.microsoft.com.
is_only_microsoft_sources() {
  awk '
    BEGIN { in_uris = 0; ms = 0; other = 0 }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { in_uris = 0; next }
    /^[[:space:]]/ {
      if (!in_uris) next
      n = split($0, parts, /[[:space:]]+/)
      for (i = 1; i <= n; i++) {
        if (parts[i] == "") continue
        uri = tolower(parts[i])
        if (uri ~ /^https?:\/\/packages\.microsoft\.com(\/|$)/) ms++
        else other++
      }
      next
    }
    {
      lower = tolower($0)
      if (lower ~ /^uris:[[:space:]]*/) {
        in_uris = 1
        rest = $0
        sub(/^[Uu][Rr][Ii][Ss]:[[:space:]]*/, "", rest)
        n = split(rest, parts, /[[:space:]]+/)
        for (i = 1; i <= n; i++) {
          if (parts[i] == "") continue
          uri = tolower(parts[i])
          if (uri ~ /^https?:\/\/packages\.microsoft\.com(\/|$)/) ms++
          else other++
        }
      } else {
        in_uris = 0
      }
    }
    END { exit (ms > 0 && other == 0) ? 0 : 1 }
  ' "$1"
}

rm_file() {
  if [ "$(id -u)" -eq 0 ] || [ -w "$dir" ]; then
    rm -f -- "$1"
  else
    sudo rm -f -- "$1"
  fi
}

shopt -s nullglob
removed=0
for file in "$dir"/*.list "$dir"/*.sources; do
  [ -f "$file" ] || continue
  # Quick pre-filter: skip files that do not mention packages.microsoft.com at all.
  grep -qiF 'packages.microsoft.com' "$file" || continue
  case "$file" in
    *.list)
      if is_only_microsoft_list "$file"; then
        rm_file "$file"
        echo "drop-microsoft-apt-source: removed $file"
        removed=$((removed + 1))
      else
        echo "drop-microsoft-apt-source: skipped mixed/non-microsoft file $file" >&2
      fi
      ;;
    *.sources)
      if is_only_microsoft_sources "$file"; then
        rm_file "$file"
        echo "drop-microsoft-apt-source: removed $file"
        removed=$((removed + 1))
      else
        echo "drop-microsoft-apt-source: skipped mixed/non-microsoft file $file" >&2
      fi
      ;;
  esac
done

if [ "$removed" -eq 0 ]; then
  echo "drop-microsoft-apt-source: no packages.microsoft.com apt sources found in $dir"
fi
