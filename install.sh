#!/bin/sh
# Installs sof for the current user (macOS / Linux).
#   curl -fsSL https://github.com/sovvie/sof/releases/latest/download/install.sh | sh
# Set SOF_CLI_REPO to install from a fork, SOF_HOME to change the install folder,
# SOF_SKIP_TOOLS=1 to skip preparing sof's tool shims.
set -eu

REPO="${SOF_CLI_REPO:-sovvie/sof}"
SOF_HOME="${SOF_HOME:-$HOME/.sof}"

if ! command -v node >/dev/null 2>&1; then
  echo "sof needs Node.js 20.19 or newer. Install it from https://nodejs.org, then run this again." >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'; then
  echo "sof needs Node.js 20.19 or newer (found $(node --version)). Update it, then run this again." >&2
  exit 1
fi

echo "Finding the latest sof release..."
RELEASE_JSON=$(curl -fsSL -H "User-Agent: sof-installer" "https://api.github.com/repos/$REPO/releases/latest")
TAG=$(printf '%s' "$RELEASE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')
URL=$(printf '%s' "$RELEASE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=(JSON.parse(s).assets||[]).find(x=>/^sof-.*\.zip$/.test(x.name));if(!a)process.exit(1);console.log(a.browser_download_url)})') || {
  echo "Release $TAG has no sof-<version>.zip asset." >&2
  exit 1
}
VERSION="${TAG#v}"

CLI_DIR="$SOF_HOME/cli/$VERSION"
BIN_DIR="$SOF_HOME/bin"
TMP_ZIP=$(mktemp -t sof.XXXXXX)

echo "Downloading sof $VERSION..."
curl -fsSL "$URL" -o "$TMP_ZIP"
rm -rf "$CLI_DIR"
mkdir -p "$CLI_DIR" "$BIN_DIR"
if ! command -v unzip >/dev/null 2>&1; then
  echo "sof's installer needs unzip (e.g. sudo apt install unzip)." >&2
  exit 1
fi
unzip -q "$TMP_ZIP" -d "$CLI_DIR"
rm -f "$TMP_ZIP"

echo "Installing dependencies..."
(cd "$CLI_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

cat > "$BIN_DIR/sof" <<EOF
#!/bin/sh
exec node "$CLI_DIR/bin/sof.js" "\$@"
EOF
chmod +x "$BIN_DIR/sof"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    for PROFILE in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$PROFILE" ] && ! grep -q "$BIN_DIR" "$PROFILE"; then
        printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
      fi
    done
    echo "Added $BIN_DIR to your PATH (restart your shell)."
    ;;
esac

# sof manages tools (rojo, selene, ...) itself: prepare its shims now so `sof run install` can install a project's tools.
if [ -z "${SOF_SKIP_TOOLS:-}" ]; then
  echo "Setting up tools..."
  "$BIN_DIR/sof" run tools setup || echo "Tool setup failed; it will be retried the first time you run: sof run install"
fi

# Keep AI coding tools (Claude Code, Cursor CLI) from reading or editing ~/.sof, where sign-ins live.
# Opt out with SOF_AI_GUARD=off, or later with: sof run account guard --off
"$BIN_DIR/sof" run account guard --quiet || true

echo ""
echo "sof $VERSION is installed. Open a new terminal, then run: sof --help"
echo "Optional features: sof run addon list"
