#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ELECTRON_RUN_AS_NODE=1 exec "$directory/../../mira-graphical" "$directory/mira-lsp.cjs" --stdio
