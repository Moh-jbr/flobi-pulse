#!/usr/bin/env bash
# Installs Flobi Pulse for the current user: copies the AppImage where you choose,
# then adds it to the app menu and the Desktop. No sudo needed. Running it again
# with a newer AppImage upgrades in place (the app also updates itself).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(ls "$here"/Flobi-Pulse-*.AppImage 2>/dev/null | head -n 1 || true)"
if [ -z "$src" ]; then
  echo "Couldn't find Flobi-Pulse-<version>.AppImage next to this script." >&2
  exit 1
fi

default="$HOME/Applications"
read -r -p "Where should Flobi Pulse go? [$default] " dir
dir="${dir:-$default}"
dir="${dir/#\~/$HOME}"
mkdir -p "$dir"
app="$dir/Flobi-Pulse.AppImage"
cp -f "$src" "$app"
chmod 755 "$app"

icon="$HOME/.local/share/icons/flobi-pulse.png"
mkdir -p "$(dirname "$icon")"
cp -f "$here/flobi-pulse.png" "$icon"

# Ubuntu 24.04+ blocks the Chromium sandbox that AppImages rely on (unprivileged
# user namespaces), so there the app has to start with --no-sandbox.
flags=""
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  flags=" --no-sandbox"
fi

entry="[Desktop Entry]
Type=Application
Name=Flobi Pulse
Comment=Live health monitor for the Flobi platform (read-only)
Exec=\"$app\"$flags %U
Icon=$icon
Terminal=false
Categories=Development;Monitor;"

apps="$HOME/.local/share/applications"
mkdir -p "$apps"
printf '%s\n' "$entry" > "$apps/flobi-pulse.desktop"
chmod 755 "$apps/flobi-pulse.desktop"

desktop="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
where="your app menu"
if [ -d "$desktop" ]; then
  where="your app menu and on your Desktop"
  printf '%s\n' "$entry" > "$desktop/flobi-pulse.desktop"
  chmod 755 "$desktop/flobi-pulse.desktop"
  # GNOME only launches Desktop shortcuts marked as trusted.
  gio set "$desktop/flobi-pulse.desktop" metadata::trusted true 2>/dev/null || true
fi
update-desktop-database "$apps" 2>/dev/null || true

echo
echo "Installed: $app"
echo "Flobi Pulse is in $where."
read -r -p "Open it now? [Y/n] " open
if [ "${open:-y}" != "n" ] && [ "${open:-y}" != "N" ]; then
  # shellcheck disable=SC2086
  nohup "$app"$flags >/dev/null 2>&1 &
fi
