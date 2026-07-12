#!/bin/bash
# Refresh FUB Nurture Dashboard Data
# This exports live SQLite database audit logs to the static dashboard data folder.

set -e

# Navigate to automation directory
cd "$(dirname "$0")"

# Execute data exporter
if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
fi

python3 export_dashboard_data.py

echo "[$(date -uIs)] Dashboard data successfully refreshed."
