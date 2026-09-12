#!/bin/sh
set -eu

dispatch_dir=${0%/*}
exec sh "$dispatch_dir/../scripts/run-node.sh" "$dispatch_dir/dispatch.mjs"
