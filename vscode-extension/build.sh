#!/usr/bin/env bash
# Sync the shared UI from ../public + ../lib into media/, then package the .vsix.
set -e
cd "$(dirname "$0")"
mkdir -p media
cp ../public/*.js ../public/*.css media/
# shared render lib (Markdown→HTML, line injection) used by the extension host
cp ../lib/render.js media/render-lib.mjs
npx -y @vscode/vsce package --no-dependencies --allow-missing-repository
