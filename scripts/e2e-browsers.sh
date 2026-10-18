#!/usr/bin/env bash
# Runs the browser suite once per engine against a fresh database each time (the specs share state, so engines cannot run together).
#   pnpm test:e2e:browsers            # chromium, firefox, webkit
#   E2E_ENGINES="firefox webkit" pnpm test:e2e:browsers
# Firefox and WebKit need `pnpm exec playwright install --with-deps firefox webkit` first. Only Chromium has been run for this project.
set -u
engines="${E2E_ENGINES:-chromium firefox webkit}"
status=0
for e in $engines; do
  echo "=== $e ==="
  E2E_BROWSER="$e" pnpm exec playwright test tests/e2e || status=1
done
exit $status
