#!/bin/sh
# GIRAFE node kit launcher for macOS and Linux. Started by "Start GIRAFE kit (Mac).command".
# Uses Node 22+ if this computer has it; otherwise downloads a private copy of Node into
# this folder (.runtime), checks it against nodejs.org's published checksum, and uses that.
set -e
KIT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=22.22.0
MIRROR=${GIRAFE_NODE_MIRROR:-https://nodejs.org/dist}
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Unsupported system: $(uname -s)"; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "Unsupported processor: $(uname -m)"; exit 1 ;; esac
NAME=node-v$VERSION-$OS-$ARCH
RUNTIME=$KIT/.runtime
LOCAL=$RUNTIME/$NAME/bin/node

fail() { echo; echo "  Could not start: $1"; echo; printf '  Press Enter to close'; read _; exit 1; }

NODE=
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -v | sed 's/^v//; s/\..*//')
  [ "$MAJOR" -ge 22 ] 2>/dev/null && NODE=$(command -v node)
fi
[ -z "$NODE" ] && [ -x "$LOCAL" ] && NODE=$LOCAL
if [ -z "$NODE" ]; then
  echo; echo "  First start: getting Node.js (about 30 MB, once). Please wait..."
  mkdir -p "$RUNTIME"
  TGZ=$RUNTIME/$NAME.tar.gz
  curl -fsSL "$MIRROR/v$VERSION/$NAME.tar.gz" -o "$TGZ" || fail "download failed. Check your internet connection."
  WANT=$(curl -fsSL "$MIRROR/v$VERSION/SHASUMS256.txt" | awk -v f="$NAME.tar.gz" '$2 == f { print $1 }')
  [ -n "$WANT" ] || fail "no checksum published for $NAME.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$TGZ" | awk '{print $1}'); else GOT=$(shasum -a 256 "$TGZ" | awk '{print $1}'); fi
  [ "$WANT" = "$GOT" ] || { rm -f "$TGZ"; fail "the download does not match nodejs.org's checksum; it was deleted. Try again later."; }
  echo "  Checksum OK. Unpacking..."
  tar -xzf "$TGZ" -C "$RUNTIME" && rm -f "$TGZ"
  NODE=$LOCAL
fi
echo; echo "  Starting... your browser will open. Keep this window open while you use the kit;"
echo "  close it (or press Ctrl+C) to stop."
exec "$NODE" "$KIT/kit.js"
