#!/usr/bin/env python3
"""
LDR Unified Nightly Health Check — HTML Email Report Generator
Generates the morning report email for peter@lifestyledesignrealty.com
and steven@lifestyledesignrealty.com
"""
import json
import datetime
import sys

# Load data files
def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}

observations_raw = load_json("/tmp/observations.json")
bot_status_raw = load_json("/tmp/bot_status.json")
monitor_status_raw = load_json("/tmp/monitor_status.json")
bot_run_history_raw = load_json("/tmp/bot_run_history.json")
audit_status_raw = load_json("/tmp/audit_status.json")

# Parse data
observations = observations_raw.get("result", {}).get("data", {}).get("json", [])
bot_status = bot_status_raw.get("result", {}).get("data", {}).get("json", {})
monitor_runs = monitor_status_raw.get("result", {}).get("data", {}).get("json", [])
bot_runs = bot_run_history_raw.get("result", {}).get("data", {}).get("json", [])
audit_status = audit_status_raw.get("result", {}).get("data", {}).get("json", {})

now_utc = datetime.datetime.now(datetime.UTC)
# Convert to CT (UTC-5 in June, CDT)
now_ct = now_utc - datetime.timedelta(hours=5)
cutoff = now_utc - datetime.timedelta(hours=25)

# Filter observations to last 25 hours
recent_obs = []
for obs in observations:
    try:
        ts = datetime.datetime.fromisoformat(obs["createdAt"].replace("Z", "+00:00"))
        if ts >= cutoff:
            recent_obs.append(obs)
    except:
        recent_obs.append(obs)

# Categorize
errors = [o for o in recent_obs if o.get("severity") == "error"]
warnings_unique = []
seen_warning_cats = set()
for o in recent_obs:
    if o.get("severity") == "warning":
        cat = o.get("category", "")
        if cat not in seen_warning_cats:
            warnings_unique.append(o)
            seen_warning_cats.add(cat)
infos = [o for o in recent_obs if o.get("severity") == "info"]

# Overall status
if errors:
    overall_status = "CRITICAL"
    status_color = "#dc2626"
    status_bg = "#fef2f2"
    status_icon = "🔴"
elif warnings_unique:
    overall_status = "WARNING"
    status_color = "#d97706"
    status_bg = "#fffbeb"
    status_icon = "🟡"
else:
    overall_status = "HEALTHY"
    status_color = "#16a34a"
    status_bg = "#f0fdf4"
    status_icon = "🟢"

# Pond nurture check
pond_errors = [o for o in recent_obs if o.get("source") == "pond_nurture" and o.get("severity") == "error"]
pond_success = [o for o in recent_obs if o.get("source") == "pond_nurture" and o.get("severity") == "info"]

# Nightly healer check
healer_warnings = [o for o in recent_obs if o.get("category") == "nightly_healer_last_ran"]
healer_obs = [o for o in recent_obs if o.get("source") == "nightly_healer"]

# Latest monitor run
latest_monitor = monitor_runs[0] if monitor_runs else {}
monitor_findings = latest_monitor.get("findings", [])
monitor_issues = [f for f in monitor_findings if f.get("status") != "ok"]
monitor_ok = [f for f in monitor_findings if f.get("status") == "ok"]

# Bot status
agents = bot_status.get("agents", [])

# Reply intent
reply_obs = [o for o in recent_obs if o.get("source") == "reply_intent"]

# Lifestyle bot
lifestyle_obs = [o for o in recent_obs if o.get("source") == "lifestyle_bot"]

# Build HTML
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LDR Morning Health Report — {now_ct.strftime('%B %d, %Y')}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f1f5f9; color: #1e293b; }}
  .container {{ max-width: 680px; margin: 0 auto; background: #ffffff; }}
  .header {{ background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); padding: 32px 32px 24px; color: white; }}
  .header h1 {{ margin: 0 0 4px; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }}
  .header .subtitle {{ margin: 0; font-size: 13px; opacity: 0.8; }}
  .status-banner {{ padding: 16px 32px; background: {status_bg}; border-left: 4px solid {status_color}; }}
  .status-banner .label {{ font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: {status_color}; }}
  .status-banner .value {{ font-size: 20px; font-weight: 700; color: {status_color}; margin-top: 2px; }}
  .status-banner .meta {{ font-size: 12px; color: #64748b; margin-top: 4px; }}
  .section {{ padding: 20px 32px; border-bottom: 1px solid #e2e8f0; }}
  .section:last-child {{ border-bottom: none; }}
  .section-title {{ font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #64748b; margin: 0 0 12px; }}
  .check-row {{ display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f1f5f9; }}
  .check-row:last-child {{ border-bottom: none; }}
  .check-icon {{ font-size: 14px; flex-shrink: 0; margin-top: 1px; }}
  .check-name {{ font-size: 13px; font-weight: 600; color: #1e293b; }}
  .check-detail {{ font-size: 12px; color: #64748b; margin-top: 2px; font-family: 'SF Mono', Consolas, monospace; word-break: break-all; }}
  .check-time {{ font-size: 11px; color: #94a3b8; margin-top: 2px; }}
  .agent-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }}
  .agent-card {{ background: #f8fafc; border-radius: 8px; padding: 10px 12px; }}
  .agent-name {{ font-size: 12px; font-weight: 600; color: #475569; }}
  .agent-count {{ font-size: 20px; font-weight: 700; color: #1e293b; }}
  .agent-week {{ font-size: 11px; color: #94a3b8; }}
  .agent-bot {{ background: #eff6ff; }}
  .error-block {{ background: #fef2f2; border-radius: 8px; padding: 12px 14px; margin: 6px 0; border-left: 3px solid #dc2626; }}
  .error-source {{ font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #dc2626; }}
  .error-msg {{ font-size: 13px; font-weight: 600; color: #1e293b; margin: 2px 0; }}
  .error-detail {{ font-size: 11px; color: #64748b; font-family: monospace; word-break: break-all; }}
  .warning-block {{ background: #fffbeb; border-radius: 8px; padding: 12px 14px; margin: 6px 0; border-left: 3px solid #d97706; }}
  .warning-source {{ font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #d97706; }}
  .warning-msg {{ font-size: 13px; font-weight: 600; color: #1e293b; margin: 2px 0; }}
  .warning-detail {{ font-size: 11px; color: #64748b; }}
  .ok-row {{ font-size: 12px; color: #16a34a; padding: 3px 0; }}
  .run-row {{ font-size: 12px; color: #475569; padding: 4px 0; border-bottom: 1px solid #f1f5f9; }}
  .run-row:last-child {{ border-bottom: none; }}
  .footer {{ background: #f8fafc; padding: 16px 32px; text-align: center; }}
  .footer p {{ font-size: 11px; color: #94a3b8; margin: 0; }}
  .exit-code {{ font-size: 12px; font-weight: 600; color: {'#dc2626' if errors else '#16a34a'}; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 700; text-transform: uppercase; }}
  .badge-error {{ background: #fee2e2; color: #dc2626; }}
  .badge-warning {{ background: #fef3c7; color: #d97706; }}
  .badge-ok {{ background: #dcfce7; color: #16a34a; }}
  .badge-info {{ background: #dbeafe; color: #2563eb; }}
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <h1>🏡 LDR Morning Health Report</h1>
    <p class="subtitle">Lifestyle Design Realty — Automation Stack &nbsp;|&nbsp; {now_ct.strftime('%A, %B %d, %Y')} at {now_ct.strftime('%I:%M %p')} CT</p>
  </div>

  <!-- Overall Status -->
  <div class="status-banner">
    <div class="label">Overall System Status</div>
    <div class="value">{status_icon} {overall_status}</div>
    <div class="meta">{len(errors)} error(s) &nbsp;·&nbsp; {len(warnings_unique)} unique warning(s) &nbsp;·&nbsp; {len(infos)} info events &nbsp;·&nbsp; Last 25 hours</div>
  </div>
"""

# Errors section
if errors:
    html += """
  <!-- Errors -->
  <div class="section">
    <div class="section-title">🔴 Errors Requiring Attention</div>
"""
    for e in errors:
        detail_short = (e.get("detail") or "")[:200]
        html += f"""
    <div class="error-block">
      <div class="error-source">{e.get('source', 'unknown')} &nbsp;·&nbsp; {e.get('category', '')}</div>
      <div class="error-msg">{e.get('message', 'Unknown error')}</div>
      <div class="error-detail">{detail_short}</div>
      <div class="check-time">{e.get('createdAt', '')}</div>
    </div>
"""
    html += "  </div>\n"

# Warnings section
if warnings_unique:
    html += """
  <!-- Warnings -->
  <div class="section">
    <div class="section-title">⚠️ Warnings</div>
"""
    for w in warnings_unique:
        html += f"""
    <div class="warning-block">
      <div class="warning-source">{w.get('source', 'unknown')} &nbsp;·&nbsp; {w.get('category', '')}</div>
      <div class="warning-msg">{w.get('message', '')}</div>
      <div class="warning-detail">{w.get('detail', '')[:200]}</div>
    </div>
"""
    html += "  </div>\n"

# Cloud Computer Section
html += f"""
  <!-- Cloud Computer -->
  <div class="section">
    <div class="section-title">☁️ Cloud Computer (Peter Allen's Cloud PC 2)</div>
"""

if pond_errors:
    html += f"""
    <div class="check-row">
      <div class="check-icon">❌</div>
      <div>
        <div class="check-name">Pond Nurture Script</div>
        <div class="check-detail">{(pond_errors[0].get('detail') or '')[:200]}</div>
        <div class="check-time">{pond_errors[0].get('createdAt', '')}</div>
      </div>
    </div>
"""
elif pond_success:
    html += f"""
    <div class="check-row">
      <div class="check-icon">✅</div>
      <div>
        <div class="check-name">Pond Nurture Script</div>
        <div class="check-detail">Ran successfully — {len(pond_success)} info observations</div>
      </div>
    </div>
"""
else:
    html += f"""
    <div class="check-row">
      <div class="check-icon">⚠️</div>
      <div>
        <div class="check-name">Pond Nurture Script</div>
        <div class="check-detail">No observations in last 25h — may not have run yet today</div>
      </div>
    </div>
"""

if healer_warnings:
    html += f"""
    <div class="check-row">
      <div class="check-icon">⚠️</div>
      <div>
        <div class="check-name">Nightly Healer (nightly_health.py)</div>
        <div class="check-detail">{healer_warnings[0].get('detail', '')[:200]}</div>
        <div class="check-time">Detected by Bot Monitor at {healer_warnings[0].get('createdAt', '')}</div>
      </div>
    </div>
"""
elif healer_obs:
    html += f"""
    <div class="check-row">
      <div class="check-icon">✅</div>
      <div>
        <div class="check-name">Nightly Healer (nightly_health.py)</div>
        <div class="check-detail">Ran — last observation at {healer_obs[0].get('createdAt', '')}</div>
      </div>
    </div>
"""

html += "  </div>\n"

# Bot Monitor Section
html += f"""
  <!-- Bot Monitor -->
  <div class="section">
    <div class="section-title">🤖 Bot Monitor — Latest Run ({latest_monitor.get('runAt', 'N/A')})</div>
    <div style="font-size:12px; color:#475569; margin-bottom:10px;">{latest_monitor.get('summary', 'N/A')}</div>
"""
for f in monitor_findings:
    icon = "✅" if f.get("status") == "ok" else ("❌" if f.get("status") == "error" else "⚠️")
    html += f"""
    <div class="check-row">
      <div class="check-icon">{icon}</div>
      <div>
        <div class="check-name">{f.get('check', '')}</div>
        <div class="check-detail">{(f.get('detail') or '')[:150]}</div>
      </div>
    </div>
"""
html += "  </div>\n"

# Agent Bot Status
html += f"""
  <!-- Agent Bot Status -->
  <div class="section">
    <div class="section-title">📱 Agent SMS Bot Status (Today / This Week)</div>
    <div class="agent-grid">
"""
for agent in agents:
    name = agent.get("name", "?")
    today = agent.get("todayCount", 0)
    week = agent.get("weekCount", 0)
    goal = agent.get("goal", 15)
    is_bot = agent.get("isBot", False)
    card_class = "agent-card agent-bot" if is_bot else "agent-card"
    bot_label = " 🤖" if is_bot else ""
    html += f"""
      <div class="{card_class}">
        <div class="agent-name">{name}{bot_label}</div>
        <div class="agent-count">{today} <span style="font-size:13px;color:#94a3b8;">today</span></div>
        <div class="agent-week">{week} this week (goal: {goal}/day)</div>
      </div>
"""
html += "    </div>\n  </div>\n"

# Lifestyle Bot Run History
if bot_runs:
    html += f"""
  <!-- Lifestyle Bot Run History -->
  <div class="section">
    <div class="section-title">📋 Lifestyle Bot — Recent Run History</div>
"""
    for run in bot_runs[:5]:
        run_at = run.get("runAt", "?")
        summary = run.get("summary", "N/A")
        triggered = run.get("triggeredBy", "?")
        html += f"""
    <div class="run-row">
      <strong>{run_at[:10]} {run_at[11:16]} UTC</strong> — {summary} <span style="color:#94a3b8;">(by: {triggered})</span>
    </div>
"""
    html += "  </div>\n"

# Reply Intent Scanner
if reply_obs:
    html += f"""
  <!-- Reply Intent -->
  <div class="section">
    <div class="section-title">📨 Reply Intent Scanner (Latest)</div>
    <div style="font-size:12px; color:#475569;">{reply_obs[0].get('message', '')}</div>
    <div style="font-size:11px; color:#94a3b8; margin-top:4px;">{(reply_obs[0].get('detail') or '')[:300]}</div>
    <div style="font-size:11px; color:#94a3b8; margin-top:2px;">{reply_obs[0].get('createdAt', '')}</div>
  </div>
"""

# Footer
exit_code = 1 if errors else 0
html += f"""
  <!-- Footer -->
  <div class="footer">
    <p class="exit-code">Script Exit Code: {exit_code} &nbsp;·&nbsp; {'ERRORS FOUND' if errors else 'CLEAN RUN'}</p>
    <p style="margin-top:6px;">Generated by Manus Nightly Health Check &nbsp;·&nbsp; {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC</p>
    <p>Dashboard: <a href="https://fub-nurture-phfprjui.manus.space" style="color:#2563eb;">fub-nurture-phfprjui.manus.space</a></p>
  </div>

</div>
</body>
</html>"""

# Save HTML
with open("/tmp/health_report.html", "w") as f:
    f.write(html)

print(f"HTML report generated: /tmp/health_report.html")
print(f"Overall status: {overall_status}")
print(f"Errors: {len(errors)}, Warnings: {len(warnings_unique)}, Info: {len(infos)}")
print(f"Exit code: {exit_code}")

sys.exit(exit_code)
