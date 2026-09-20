#!/usr/bin/env bash
#
# Deploy PagePocket Web to Vercel, under the same team as the other projects
# on this machine (team_cYwhvlK1rtXWMKQFA3B7WYUd).
#
# Run this once interactively: `vercel login` opens a browser, which is the only
# part that cannot be automated.
set -euo pipefail

# Scope of the account that actually owns the other project on this machine.
#
# Note: Yuvaplannextech's local .vercel/project.json records orgId
# "team_cYwhvlK1rtXWMKQFA3B7WYUd", but that team is NOT visible to the signed-in
# CLI account -- the project is really owned by the personal scope below, and its
# projectId (prj_yX4yWsl3fb3kPKfAreVZRlOpcmLt) matches. The stored orgId is stale,
# so it is deliberately not used here.
SCOPE="rajualankar2-7622s-projects"
PROJECT="pagepocket-web"

cd "$(dirname "$0")"

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI not found. Install it with:  npm install -g vercel"
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Not signed in. Opening the browser to authenticate…"
  echo "(This is the one step that has to be done by a human.)"
  vercel login
fi

echo
echo "Signed in as: $(vercel whoami 2>/dev/null | tail -1)"

# Link to the existing team so this project sits alongside the others, rather
# than under a personal scope.
if [ ! -f .vercel/project.json ]; then
  echo "Linking project…"
  vercel link --yes --project "$PROJECT" --scope "$SCOPE"
fi

echo
echo "Deploying to production…"
vercel deploy --prod --yes --scope "$SCOPE"
