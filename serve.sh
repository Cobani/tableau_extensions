#!/usr/bin/env bash
# Serves every extension on http://localhost:8766 (one port for all) and lists Tableau shape palettes
# for the Format dialogs' icon pickers.
# Dev preview (no Tableau needed): http://localhost:8766/<slug>/dev/preview.html  (e.g. bar-chart, waterfall)
set -euo pipefail
cd "$(dirname "$0")"
exec python3 serve.py
