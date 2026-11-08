#!/usr/bin/env bash
# Double-click (or run) this to start Craftie. Downloads what it needs the first time.
set -e
cd "$(dirname "$0")"
NODE=node
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 23 ]; then
  if [ ! -x runtime/node/bin/node ]; then
    echo "First run: downloading Node.js (one time only)..."
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64) P=linux-x64 ;; Linux-aarch64) P=linux-arm64 ;;
      Darwin-arm64) P=darwin-arm64 ;; Darwin-x86_64) P=darwin-x64 ;;
      *) echo "Unsupported system: $(uname -sm). Install Node.js 24+ from nodejs.org"; exit 1 ;;
    esac
    F=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v p="$P.tar.gz" '$2 ~ p"$" {print $2; exit}')
    mkdir -p runtime && curl -fL "https://nodejs.org/dist/latest-v24.x/$F" | tar -xz -C runtime
    rm -rf runtime/node && mv "runtime/${F%.tar.gz}" runtime/node
  fi
  NODE="$PWD/runtime/node/bin/node"
  export PATH="$PWD/runtime/node/bin:$PATH"
fi
if [ ! -d node_modules ]; then echo "First run: installing parts (one time only)..."; npm install --no-audit --no-fund; fi
exec "$NODE" src/app.ts
