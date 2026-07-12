# PII Audit — Lines to Fix

## main.py (pond-nurture-bot/src/fub_automation/main.py)

### DRY_RUN sender logs (expose to/from emails, phone numbers, subjects with lead names)
- Line 1470: `LOGGER.info("DRY_RUN email from=%s to=%s cc=%s subject=%s", selected_from, to_email, cc, subject)`
  - FIX: Remove from/to/cc, keep subject but strip lead names from it
  - Actually: just log "DRY_RUN email to person_id=X" — but we don't have person_id here. 
  - Best: mask emails entirely, log "DRY_RUN email sent (subject_len=%d chars)"
  
- Line 1497: `LOGGER.info("DRY_RUN sms to=%s body=%s", to_number, body[:80])`
  - FIX: `LOGGER.info("DRY_RUN sms to=<redacted> body_len=%d", len(body))`

### Speed-to-lead alert (exposes agent email, lead name in subject)
- Line 4178: subject contains `lead_name` — this gets logged via DRY_RUN email at line 1470
- Line 4207: `self.db.log("speed_to_lead_alert", "sent", int(person["id"]), {"agent_email": agent_email, "agent_name": agent_name})`
  - DB audit log stores agent_email — OK for DB (encrypted), but if echoed to daily summary it leaks
- Line 4208: `LOGGER.info("Speed-to-lead agent alert sent to %s for lead %s", agent_email, person["id"])`
  - FIX: `LOGGER.info("Speed-to-lead agent alert sent for lead %s", person["id"])`

### Speed-to-lead reassignment (exposes lead name in subject, agent name)
- Line 4229: subject = f"⚠️ Lead Reassigned: {lead_name} ..." — logged via DRY_RUN email
- Line 4245: `LOGGER.warning("Failed to send reassignment email to Peter for lead %s: %s", person_id, mail_exc)`
  - OK — only person_id

### Reply detection (exposes reply snippet, agent email/name, lead name)
- Line 4568: `LOGGER.info("Reply detected for lead %s via %s: %s", person_id, reply_channel, reply_snippet[:80])`
  - FIX: Remove reply_snippet from log
- Line 4596: `lead_name = ...` used in alert_subject — logged via DRY_RUN email
- Line 4619-4624: `self.db.log(...{"reply_snippet": ..., "agent_email": ..., "agent_name": ...})`
  - DB audit stores PII — OK for encrypted DB, but remove from LOGGER output

### AI email-change detector (exposes new_email address)
- Line 1427: `LOGGER.warning("detect_email_change: AI returned invalid email format '%s'...", new_email, ...)`
  - FIX: Remove new_email from log
- Line 1435: `LOGGER.info("detect_email_change: low confidence...new_email='%s'...", ...new_email, reason)`
  - FIX: Remove new_email from log
- Line 1442: `LOGGER.info("detect_email_change: person %s new_email='%s'...", ...new_email, ...)`
  - FIX: Remove new_email from log

### Pre-send opt-out detection (exposes person_name, trigger_snippet)
- Line 3493: `LOGGER.warning("PRE-SEND OPT-OUT DETECTED: Lead %s (%s) has opt-out language in %s...Snippet: %s", person_id, person_name, trigger_source, trigger_snippet[:100])`
  - FIX: Remove person_name and trigger_snippet from log
- Line 3518-3523: `self.db.log(...{"person_name": person_name, "trigger_snippet": ...})`
  - DB stores PII — OK for encrypted DB

### Active deal logging (exposes deal name, pipeline name)
- Line 3592: `LOGGER.info("Person %s has active deal '%s' in pipeline '%s'...", person_id, deal.get("name"), deal.get("pipelineName"))`
  - FIX: Remove deal name, just log "Person %s has active deal — protected"

### Reply intent scan (exposes person_name)
- Line 2519: `LOGGER.exception("Reply intent scan failed for person %s (%s)", person_id, person_name)`
  - FIX: Remove person_name

### Congrats email (exposes to_email, deal_address)
- Line 1722: `LOGGER.info("Phase 3b: Congrats email sent to %s (person %s, address: %s)", to_email, person_id, deal_address or "unknown")`
  - FIX: `LOGGER.info("Phase 3b: Congrats email sent for person %s", person_id)`

### DRY_RUN add_note (exposes note subject which may contain lead names)
- Line 627: `LOGGER.info("DRY_RUN add_note %s %s", person_id, subject)`
  - The subject itself may contain lead names (e.g., "Speed-to-lead reassignment")
  - Actually most note subjects are generic automation labels — OK to keep

## nightly_health.py

### Bounce/unsub detection (exposes email subjects, message bodies)
- Line 1023: `log.info("BOUNCE detected: person_id=%s subject=%s", person_id, subject[:50])`
  - FIX: `log.info("BOUNCE detected: person_id=%s", person_id)`
- Line 1034: `log.info("OPT-OUT detected: person_id=%s body=%s", person_id, body[:50])`
  - FIX: `log.info("OPT-OUT detected: person_id=%s", person_id)`
- Line 1064: `log.info("TEXT OPT-OUT detected: person_id=%s body=%s", person_id, body[:50])`
  - FIX: `log.info("TEXT OPT-OUT detected: person_id=%s", person_id)`

### Morning email dry-run (exposes recipient email, subject, body preview)
- Line 1428: `log.info("[DRY-RUN] Would send morning email to %s", to_email)`
  - FIX: `log.info("[DRY-RUN] Would send morning email")`
- Line 1429: `log.info("[DRY-RUN] Subject: %s", subject)`
  - FIX: Remove (subject is generic "Nightly Health" — actually OK, but be safe)
- Line 1430: `log.info("[DRY-RUN] Body preview:\n%s", body[:800])`
  - FIX: `log.info("[DRY-RUN] Body length: %d chars", len(body))`
- Line 1451: `log.info("Morning email sent to %s", to_email)`
  - FIX: `log.info("Morning email sent successfully")`

## weekly_digest.py

- Line 252: `LOGGER.info("Weekly digest sent to %s", to_email)`
  - FIX: `LOGGER.info("Weekly digest sent successfully")`
- Line 287: `print(html[:2000])` — dumps HTML to stdout in dry-run
  - FIX: Remove entirely (or `LOGGER.info("[DRY-RUN] Digest HTML length: %d chars", len(html))` — already logged on line 286)
