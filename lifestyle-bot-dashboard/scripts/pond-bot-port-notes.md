# Pond Nurture Bot — Key Logic for TypeScript Port

## Core Flow (process_reengagement_candidate)
1. Check excluded stages: Trash, Closed, Under Contract
2. Check manual suppression tags: "Do Not Nurture", "No AI Email"
3. Check qualifies_for_reengagement: lead must be in configured pond (assignedPondId exists)
4. Check 14-day cadence: skip if last reengagement was <14 days ago
5. Check email exists: skip if no email on lead
6. LLM skip check (should_skip_lead_llm): AI reviews notes for 4 intents:
   - A: Lead bought/closed elsewhere
   - B: Working with another agent
   - C: Asked to stop receiving outreach
   - D: Permanently relocated away from Texas
7. Check was_contacted_recently (3 days): skip if any omnichannel touch in last 3 days
8. Get city, lead_context, market_context, recent_note_text
9. Generate AI email (with anti-hallucination rules now applied)
10. Send email from peter@lifestyledesignrealty.com
11. Add FUB note: "Automated two-week pond nurture outreach sent"
12. Log to audit DB

## Key Config Values (from rules.yaml defaults)
- excluded_stages: ["Trash", "Closed", "Under Contract"]
- email_opt_out_tags: ["email opt out", "unsubscribe"]
- reengagement_cadence_days: 14
- phase2_manual_suppression_tags: ["Do Not Nurture", "No AI Email"]
- email_outreach_enabled: true
- pond_nurture_sms_enabled: false (SMS disabled)
- owner_email: peter@lifestyledesignrealty.com
- company_name: Lifestyle Design Realty
- Pond ID to target: 2 (Lead Pond)

## Email Generation (generate() method)
- Model: gpt-4.1-mini (temperature 0.86)
- Angle options rotated per cycle:
  - "quick local market pulse and buying-power question"
  - "neighborhood lifestyle and community highlight"
  - "home search strategy tip or buyer insight"
  - "rate or affordability context with gentle question"
  - "seasonal or timely real estate observation"
  - "relocation or life-change check-in"
  - "investment or equity-building angle"
- Referral ask: 1 in 4 chance per email
- Output: JSON { subject, email_body }
- Style: warm, personal, 2-4 emojis, no dashes, no bullet points, 120-190 words
- Signs off as "Peter" only

## Email Footer (appended separately)
- Unsubscribe link + company info

## FUB API Calls Needed
- GET /people?assignedPondId[]=2&limit=100 (paginated)
- GET /notes?personId={id}&sort=-created&limit=10
- POST /notes (to log the outreach)
- GET /events?personId={id} (for omnichannel touch check)

## Heartbeat Constraints
- Handler timeout: 2 minutes per call
- Must be idempotent
- Cannot process all 2000+ pond leads in one call
- Solution: Process in batches (e.g., 10-15 leads per heartbeat call)
  OR use a single daily run that processes up to 100 leads (matching Python's cap)

## Python's Daily Cap
- 100 emails per day max (launch_cap)
- Processes leads sorted by last reengagement date (oldest first)
