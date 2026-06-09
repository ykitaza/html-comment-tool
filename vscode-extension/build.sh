#!/usr/bin/env bash
# Sync the shared UI from ../public into media/, then package the .vsix.
set -e
cd "$(dirname "$0")"
mkdir -p media
cp ../public/*.js ../public/*.css media/
npx -y @vscode/vsce package --no-dependencies --allow-missing-repository
