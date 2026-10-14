#!/usr/bin/env bash
# Keep native navigation and shared design tokens consistent across Apple views.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${1:-$repo_root/apps/apple/Shared}"
if ! command -v rg >/dev/null 2>&1; then
  echo 'Apple UI lint requires ripgrep (rg).' >&2
  exit 2
fi
if [[ ! -d "$source_root" ]]; then
  echo "Apple UI source directory does not exist: $source_root" >&2
  exit 2
fi

violations=0
check() {
  local description="$1"
  shift
  local result=0
  # ripgrep: 0 = matches, 1 = no matches, 2+ = tool/input failure.
  # Never turn a broken check into a successful lint run.
  if rg -n "$@" --glob '!**/DesignSystem/**' "$source_root"; then
    echo "Apple UI lint: $description" >&2
    violations=1
  else
    result=$?
    if [[ "$result" -ne 1 ]]; then
      echo "Apple UI lint could not complete ($description, rg exit $result)." >&2
      exit "$result"
    fi
  fi
}

check 'use named design tokens instead of inline colors, sizes, or corner radii' \
  --glob '*.swift' \
  -e '\bColor[[:space:]]*\(' \
  -e '\bColor\.(accentColor|blue|purple)\b' \
  -e '\.foregroundColor\([[:space:]]*\.accentColor' \
  -e '\.font\([[:space:]]*\.system\([[:space:]]*size:' \
  -e 'cornerRadius:[[:space:]]*[0-9]'
check 'use system tab navigation; do not imitate or recolor its glass' \
  --glob '*.swift' \
  -e '\.(ultraThinMaterial|regularMaterial)\b' \
  -e 'toolbarBackground\([^\n]*tabBar'
check 'keep technical language out of the chat path' \
  --glob '**/ChatView.swift' --glob '**/MessageBubble.swift' --glob '**/RootView.swift' \
  --glob '**/ConversationListView.swift' --glob '**/LiveStatusAccessory.swift' \
  -e '助手|AI|生成|模型'

if [[ "$violations" -ne 0 ]]; then
  exit 1
fi
echo 'Apple UI lint passed.'
