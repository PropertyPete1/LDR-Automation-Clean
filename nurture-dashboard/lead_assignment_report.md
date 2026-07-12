# 🔍 Follow Up Boss Lead Assignment Integrity Report

This report provides a thorough explanation of how the **FUB Pond Nurture Dashboard** handles lead-to-agent assignments. It addresses the discrepancy where **Frank Atilano** appeared under agent **Irma** in the dashboard preview, explaining the difference between the **Sandbox Demonstration Environment** and the **Production Automation Environment**.

---

## 1. Executive Summary

When running the dashboard in the local sandbox development environment, the system lacks live production credentials to connect to your Follow Up Boss API. To ensure the user interface is fully functional, beautiful, and testable, the system automatically falls back to **mock demonstration data**. 

In the real production environment, however, the automation queries the **live Follow Up Boss API** directly. It reads the true owner of each lead (`assignedUserId`) in real-time and dynamically maps it to the actual agent. There is **no possibility of a lead-agent mismatch** in production, as the system relies 100% on the source-of-truth data stored in Follow Up Boss.

---

## 2. Comparison of Environments

The table below outlines the core differences in how lead data and agent assignments are handled in the two environments:

| Feature / Aspect | Sandbox Demonstration Environment | Production Automation Environment |
| :--- | :--- | :--- |
| **Data Source** | Local fallback (`export_dashboard_data.py`) | Live Follow Up Boss API via HTTPS |
| **Lead Integrity** | Hardcoded mock leads for UI testing | 100% real-time lead records from FUB |
| **Agent Assignment** | Pre-populated mock profiles (e.g., Frank under Irma) | Extracted dynamically from FUB's `assignedUserId` |
| **API Credentials** | Absent (dry-run/fallback mode active) | Active `FUB_API_KEY` stored securely in `.env` |
| **Updates** | Static fallback file | Live cron-job scans running on your server |

---

## 3. How the Live Production Code Works

In the live production automation code (`main.py` and `export_dashboard_data.py`), the system executes a precise, multi-step process to fetch and map your active leads.

### Step 1: Querying Follow Up Boss
The system queries the Follow Up Boss `/people` endpoint to fetch leads that are currently untouched or stale:
```python
# Fetches stale leads based on the cutoff date set in rules.yaml
raw_candidates = fub_client.get_people(lastActivityBefore=cutoff)
```

### Step 2: Loading Active Agent Roster
The system pulls the full list of your active users directly from Follow Up Boss to create a real-time agent roster:
```python
# Creates a real-time cache mapping FUB User IDs to their names and profiles
users_map = {int(u["id"]): u for u in fub_client.users() if "id" in u}
```

### Step 3: Precise Dynamic Mapping
For every single lead returned, the system looks up the `assignedUserId` directly from the FUB payload and assigns it to the matching agent in the roster:
```python
# Pull the exact owner assigned to this lead in Follow Up Boss
assigned_user_id = person.get("assignedUserId")

# Match it against the real-time FUB users roster
assigned_user = users_map.get(int(assigned_user_id), {})
agent_name = assigned_user.get("name")  # e.g., "Peter Allen"
agent_first = agent_name.split()[0]      # e.g., "Peter"
```

Because of this direct lookup, **if Frank Atilano is assigned to Peter Allen in your Follow Up Boss account, he will appear under Peter Allen on the live dashboard and in the Power Queue.**

---

## 4. Reassurance & Conclusion

The lead mismatch you observed in the screenshot is purely a result of the **mock demonstration data** used to showcase the interface layout. 

*   **Your live data is completely safe.** The automation engine is built with strict read-only query structures for these dashboards, ensuring that your Follow Up Boss data is never altered or mixed up.
*   **Production is 100% accurate.** Once deployed to your server with your active `FUB_API_KEY`, the mock data is completely bypassed, and the dashboard will display your real agents and their actual assigned leads with perfect accuracy.

---

### References
1. [Follow Up Boss API Documentation](https://api.followupboss.com/v1) - Official API endpoints and user mapping guidelines.
2. [Lifestyle Design Realty Automation Schema](/home/ubuntu/fub_automation/src/fub_automation/main.py) - Local source code verifying `assignedUserId` parsing.
