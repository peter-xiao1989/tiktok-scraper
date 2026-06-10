#!/usr/bin/env bash
# GCP Cloud Scheduler — most punctual trigger (has SLA). Run once to create both
# jobs. Requires: a GCP project, `gcloud` CLI authed, Cloud Scheduler API enabled.
#
# Usage:
#   GCP_PROJECT=my-project GH_PAT=github_pat_xxx bash setup-cloud-scheduler.sh
set -euo pipefail

: "${GCP_PROJECT:?set GCP_PROJECT}"
: "${GH_PAT:?set GH_PAT (GitHub fine-grained PAT, Actions: Read and write)}"
REPO="${REPO:-peter-xiao1989/tiktok-scraper}"
LOCATION="${LOCATION:-asia-east1}"

HEADERS="Authorization=Bearer ${GH_PAT},Accept=application/vnd.github+json,Content-Type=application/json"

create() {
  local name="$1" schedule="$2" workflow="$3"
  gcloud scheduler jobs create http "$name" \
    --project="$GCP_PROJECT" \
    --location="$LOCATION" \
    --schedule="$schedule" \
    --time-zone="Asia/Shanghai" \
    --uri="https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches" \
    --http-method=POST \
    --headers="$HEADERS" \
    --message-body='{"ref":"main"}' \
    || gcloud scheduler jobs update http "$name" \
    --project="$GCP_PROJECT" \
    --location="$LOCATION" \
    --schedule="$schedule" \
    --time-zone="Asia/Shanghai" \
    --uri="https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches" \
    --http-method=POST \
    --update-headers="$HEADERS" \
    --message-body='{"ref":"main"}'
}

# 16:00 BJT product, 07:00 BJT ads — exact local times, no UTC math needed.
create daily-product-1600 "0 16 * * *" daily-product.yml
create daily-ads-0700     "0 7 * * *"  daily-ads.yml

echo "Done. Verify: gcloud scheduler jobs list --project=$GCP_PROJECT --location=$LOCATION"
