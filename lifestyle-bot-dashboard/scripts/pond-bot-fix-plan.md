# Pond Bot Anti-Hallucination Fix Plan

## Location
- File: `/tmp/fub-automations-repo/pond-nurture-bot/src/fub_automation/main.py` (3978 lines)
- GitHub: `PropertyPete1/FUB-Automations` → `pond-nurture-bot/src/fub_automation/main.py`

## Key Functions to Fix

### 1. `generate()` method (line ~710)
This is the main email generation function for pond nurture emails.
- Builds a prompt with: first_name, city, safe_lead_context, recent_note_text, angle, market_context
- Uses OpenAI (gpt-4.1-mini) with temperature=0.86
- Already has some rules: "Do not claim you personally toured a property, spoke with the lead, or know private facts unless provided"
- **MISSING:** No date-awareness of notes, no staleness warning, no anti-hallucination rules about old events

### 2. `summarize_lead_context_from_notes()` (line ~3893)
- Extracts snippets from notes matching useful terms (city, buy, sell, etc.)
- Takes first 3 matching snippets, max 180 chars each
- **MISSING:** Does NOT include note dates or age labels
- Output format: "Recent FUB notes suggest: snippet1 | snippet2 | snippet3"
- The word "Recent" is misleading — these could be years-old notes!

### 3. `customer_nurture_context()` (line ~3094)
- Calls `summarize_lead_context_from_notes()` to build lead_context
- Also extracts city from notes

## Root Cause of Reneé Incident
- `summarize_lead_context_from_notes()` grabbed Oct 2024 notes mentioning "this Friday" and "setting a time"
- Passed them to `generate()` as "safe_lead_context" and "recent_note_text"
- The prompt says "Read the most recent FUB note and reference it naturally"
- AI saw "this Friday" and "setting a time" → fabricated current meeting
- No date labels on notes → AI had no way to know they were 8 months old

## Fixes Needed

### Fix 1: `summarize_lead_context_from_notes()` — Add date labels
- Include the note date and days-ago for each snippet
- Change prefix from "Recent FUB notes suggest:" to include age warning
- If ALL notes are 90+ days old, prefix with "⚠️ WARNING: These notes are very old (X+ months)"

### Fix 2: `generate()` prompt — Add anti-hallucination rules
Add to the prompt:
- NEVER invent meetings, calls, or conversations not in the notes
- PAY ATTENTION TO NOTE DATES — if a note mentions "this Friday" but is months old, that date has LONG PASSED
- If all notes are 90+ days old, write a gentle re-engagement acknowledging time has passed
- NEVER say "our recent chat" or "our conversation" unless a note from <14 days confirms it
- If unsure whether something happened recently, DO NOT MENTION IT

### Fix 3: `customer_nurture_context()` — Pass note dates through
- Ensure the note date information flows from raw notes → summarize → generate
