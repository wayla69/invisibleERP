#!/bin/bash

# Populate Product Images CLI Wrapper
#
# This script is a shell wrapper around the Node.js populate-images utility.
# It provides an easier interface for bulk image population.
#
# Usage:
#   ./tools/populate-images.sh [OPTIONS]
#
# Examples:
#   # Populate all items (uses API_TOKEN from env)
#   ./tools/populate-images.sh
#
#   # Populate specific items
#   ./tools/populate-images.sh --items ITEM-001,ITEM-002
#
#   # Provide token directly
#   ./tools/populate-images.sh --token YOUR_TOKEN

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/populate-images.js"

# Run the Node.js script with all arguments passed through
node "$NODE_SCRIPT" "$@"
