#!/bin/bash
# codex-rpc installer — https://codex-rpc.ssh.codes
# Installs the single-file CLI, then starts it in the background (auto-starts
# at login on macOS). Re-run any time to update to the latest version.
set -euo pipefail

RAW="https://raw.githubusercontent.com/SSHdotCodes/codex-rpc/main/codex-rpc.js"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "codex-rpc needs Node.js 18+ — install it first (e.g. brew install node)"; exit 1
fi
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || {
  echo "codex-rpc needs Node.js 18+ (you have $("$NODE" -v))"; exit 1; }

DIR="$HOME/.codex-rpc"
mkdir -p "$DIR"
echo "downloading codex-rpc…"
curl -fsSL "$RAW" -o "$DIR/codex-rpc.js"

BIN="$HOME/.local/bin"
if [ -w /usr/local/bin ]; then BIN=/usr/local/bin; fi
mkdir -p "$BIN"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$DIR/codex-rpc.js" > "$BIN/codex-rpc"
chmod +x "$BIN/codex-rpc"
echo "installed: $BIN/codex-rpc"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: add $BIN to your PATH →  export PATH=\"$BIN:\$PATH\"" ;;
esac

"$BIN/codex-rpc" start
echo
echo "Done! Open Discord and your profile will show 'Gaming on Codex' as you use Codex."
echo "Commands: codex-rpc logs · codex-rpc stop · codex-rpc uninstall · codex-rpc demo"
