#!/bin/sh
# Every script and stylesheet the Mini App page names gets ?v=<first 12 hex of its sha256>, so nginx lets a
# phone keep it for a year (infra/nginx.conf, $web_app_cache) and a release still reaches it at once.
# Runs in the edge image build: sh stamp-web-app-assets.sh /usr/share/osinara-public/app
set -eu
dir="$1"
page="$dir/index.html"
for file in "$dir"/*.js "$dir"/*.css; do
  name=$(basename "$file")
  hash=$(sha256sum "$file" | cut -c1-12)
  sed -i "s#=\"$name\"#=\"$name?v=$hash\"#" "$page"
done
# A local file the page names without a stamp would stay on phones as an old copy for a year.
if grep -Eq '(src|href)="[^":?]+\.(js|css)"' "$page"; then
  echo "AGENT_WEB_APP_ASSET_UNSTAMPED: $page names a script or stylesheet without ?v=" >&2
  exit 1
fi
