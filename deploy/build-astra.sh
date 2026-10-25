#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/opt/node/bin:/opt/pnpm/bin:$HOME/.cargo/bin:$PATH"
cat /etc/os-release
if ! grep -qE '^1\.8' /etc/astra_version; then
  printf '%s\n' 'Expected the official Astra Linux 1.8 userland.' >&2
  exit 1
fi
apt-get update
apt-get install -y curl git ca-certificates build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev libudev-dev librsvg2-dev libayatana-appindicator3-dev patchelf cups-client dbus-x11 xvfb xauth
npm install --global --prefix /opt/pnpm pnpm@11.25.0
curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs -o /tmp/rt-rustup.sh
sh /tmp/rt-rustup.sh -y --profile minimal --default-toolchain stable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
cargo test --locked --manifest-path apps/terminal/src-tauri/Cargo.toml --lib
pnpm --filter @rt/terminal tauri build --bundles deb --ci
mapfile -t packages < <(find apps/terminal/src-tauri/target/release/bundle/deb -maxdepth 1 -name '*.deb' -type f)
test "${#packages[@]}" -eq 1
dpkg-deb --info "${packages[0]}"
apt-get install -y "$(realpath "${packages[0]}")"
if ldd /usr/bin/results-terminal | grep 'not found'; then exit 1; fi
# Smoke-test only: no scanner, printer jobs or changes to Astra security policies.
useradd --create-home --shell /bin/bash rt-smoke
set +e
runuser -u rt-smoke -- dbus-run-session -- xvfb-run -a timeout 15s /usr/bin/results-terminal
status=$?
set -e
if [ "$status" -ne 124 ]; then
  printf 'Application did not stay alive for the smoke-test interval (exit %s).\n' "$status" >&2
  exit 1
fi
