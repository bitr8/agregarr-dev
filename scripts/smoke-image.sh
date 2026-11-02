#!/usr/bin/env bash
# Boot IMAGE with an empty config and prove the Next image optimiser is not serving.
#   smoke-image.sh IMAGE      exit 0 = passed, 1 = a probe failed, 2 = could not run
set -euo pipefail
image=${1:?usage: smoke-image.sh IMAGE}
name=agregarr-smoke-$$
port=${SMOKE_PORT:-17171}
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" -p "$port:7171" "$image" >/dev/null || exit 2
for _ in $(seq 60); do
  curl -sf "http://localhost:$port/api/v1/status" >/dev/null && break
  sleep 2
done
if ! curl -sf "http://localhost:$port/api/v1/status" >/dev/null; then
  docker logs "$name" 2>&1 | tail -50
  echo "FAIL: $image did not answer /api/v1/status within 120s"
  exit 2
fi

fail=0
# An active optimiser answers 200 (image bytes) or 400 (bad params); a disabled one never does.
for q in 'url=%2Ffavicon.ico&w=64&q=75' 'url=https%3A%2F%2Fexample.com%2Fx.svg&w=64&q=75' ''; do
  out=$(curl -s --max-time 10 -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:$port/_next/image?$q") || { echo "could not reach $image"; exit 2; }
  case "$out" in
    200*|400*|*image/*) echo "FAIL: /_next/image?$q answered $out"; fail=1 ;;
    *) echo "ok: /_next/image?$q -> $out" ;;
  esac
done
# Presence control: pages are being served, so the answers above are real.
code=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://localhost:$port/setup") || { echo "could not reach $image"; exit 2; }
if [ "$code" = 200 ]; then echo "ok: /setup -> 200"; else echo "FAIL: /setup -> $code"; fail=1; fi
exit $fail
