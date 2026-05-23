#!/usr/bin/env sh
set -e

# ─── Vertex Sandbox npm Installer ───────────────────────────────────────────
# Installs the sandbox runtime from the GitHub repo and keeps it running with
# PM2. This path is useful before the sandbox runtime is published to npm.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/backsapce/VertexAgent/main/script/install_sandbox_npm.sh | sh
# ─────────────────────────────────────────────────────────────────────────────

PACKAGE_URL="${VERTEX_SANDBOX_PACKAGE:-github:backsapce/VertexAgent}"
PM2_APP_NAME="${VERTEX_SANDBOX_PM2_NAME:-vertex-sandbox}"
WORKSPACE_DIR="${VERTEX_SANDBOX_WORKDIR:-$HOME/vertex-workspace}"
REQUIRED_NODE_MAJOR=18

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$1"; exit 1; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
  OS="$(uname -s)"
  case "$OS" in
    Linux*)  OS=linux  ;;
    Darwin*) OS=macos  ;;
    *)       error "Unsupported OS: $OS. Only Linux and macOS are supported." ;;
  esac
}

check_node_version() {
  if ! has_cmd node; then
    return 1
  fi
  NODE_VERSION="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
  [ "$NODE_MAJOR" -ge "$REQUIRED_NODE_MAJOR" ]
}

ensure_node() {
  if check_node_version; then
    info "Node.js found: $(node -v)"
    return
  fi

  info "Node.js >= $REQUIRED_NODE_MAJOR not found — installing via NodeSource..."

  if [ "$OS" = "linux" ]; then
    if has_cmd apt-get; then
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y -qq nodejs
    elif has_cmd dnf; then
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
      sudo dnf install -y nodejs
    elif has_cmd yum; then
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
      sudo yum install -y nodejs
    elif has_cmd apk; then
      sudo apk add --no-cache nodejs npm
    elif has_cmd pacman; then
      sudo pacman -Sy --noconfirm nodejs npm
    else
      error "Cannot install Node.js automatically. Please install Node.js >= $REQUIRED_NODE_MAJOR and re-run."
    fi
  elif [ "$OS" = "macos" ]; then
    if has_cmd brew; then
      brew install node
    else
      error "Please install Homebrew (https://brew.sh) or Node.js (https://nodejs.org) and re-run."
    fi
  fi

  check_node_version || error "Node.js installation failed or version too old."
  ok "Node.js installed: $(node -v)"
}

ensure_npm() {
  has_cmd npm || error "npm was not found after installing Node.js."
  info "npm found: $(npm -v)"
}

ensure_pm2() {
  if has_cmd pm2; then
    info "PM2 found: $(pm2 -v)"
    return
  fi

  info "PM2 not found — installing globally..."
  npm install -g pm2
  has_cmd pm2 || error "PM2 installation failed."
  ok "PM2 installed"
}

install_sandbox_package() {
  info "Installing Vertex Sandbox runtime from $PACKAGE_URL..."
  npm install -g "$PACKAGE_URL"
  has_cmd vertex-sandbox || error "vertex-sandbox binary was not found after install."
  ok "Vertex Sandbox runtime installed: $(command -v vertex-sandbox)"
}

start_pm2() {
  mkdir -p "$WORKSPACE_DIR"
  export AGENT_WORKING_DIR="${AGENT_WORKING_DIR:-$WORKSPACE_DIR}"
  export AGENT_FILES_DIR="${AGENT_FILES_DIR:-$AGENT_WORKING_DIR}"
  export AGENT_TOKEN_FILE="${AGENT_TOKEN_FILE:-$AGENT_WORKING_DIR/.vertex-token}"

  info "Starting $PM2_APP_NAME with PM2..."
  pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
  pm2 start "$(command -v vertex-sandbox)" \
    --name "$PM2_APP_NAME" \
    --cwd "$AGENT_WORKING_DIR" \
    --update-env \
    >/dev/null
  pm2 save
  ok "PM2 process started"
}

print_summary() {
  echo ""
  echo "============================================================"
  echo "  Vertex Sandbox installed and running with PM2"
  echo "============================================================"
  echo ""
  echo "  Process:"
  echo "    pm2 status $PM2_APP_NAME"
  echo "    pm2 logs $PM2_APP_NAME"
  echo ""
  echo "  Workspace:"
  echo "    $AGENT_WORKING_DIR"
  echo ""
  echo "  Agent endpoint: http://<host>:${AGENT_PORT:-3099}/agent"
  echo "  Health check:   http://<host>:${AGENT_PORT:-3099}/agent/health"
  echo ""
  echo "  Override package source:"
  echo "    VERTEX_SANDBOX_PACKAGE=github:user/repo#branch sh install_sandbox_npm.sh"
  echo ""
  echo "============================================================"
  echo ""
}

main() {
  echo ""
  info "Starting Vertex Sandbox npm installer..."
  echo ""
  detect_os
  ensure_node
  ensure_npm
  ensure_pm2
  install_sandbox_package
  start_pm2
  print_summary
}

main
