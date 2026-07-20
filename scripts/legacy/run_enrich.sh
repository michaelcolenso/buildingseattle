#!/bin/bash
# Wrapper to run enrichment with correct virtualenv
export VIRTUAL_ENV=/home/openclaw/project-gary/backend/.venv
export PATH="$VIRTUAL_ENV/bin:/usr/local/bin:/usr/bin:/bin"
export PYTHONPATH="$VIRTUAL_ENV/lib/python3.12/site-packages:$PYTHONPATH"

cd /home/openclaw/projects/buildingseattle
exec "$VIRTUAL_ENV/bin/python3" enrich_sdci.py \
  --input unenriched_permits.json \
  --output sdci_enrichment_20260705.jsonl \
  --delay 1.0 \
  --resume 2>&1
