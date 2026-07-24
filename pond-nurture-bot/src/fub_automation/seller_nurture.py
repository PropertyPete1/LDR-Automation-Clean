"""Seller Nurture Track — 5-email drip for leads tagged "Seller Lead" in the pond.

Sequence (email only, no texting):
  Email 1 (day 0):  Free home value / equity report offer
  Email 2 (day 4):  Neighborhood market update — homes sold recently near their area
  Email 3 (day 10): Equity angle + soft CTA to reply for a custom report
  Email 4 (day 18): Case study — helped a local homeowner sell above asking
  Email 5 (day 30): Check-in, "no rush, here whenever" + leave door open
  After email 5:    Monthly market updates (reuse pond cadence logic, 30-day interval)

Hard Rules:
  - NEVER reference divorce, foreclosure, financial situation, or how we found them
  - Personalize with property address/neighborhood from lead notes
  - Same sending convention: "Peter | Lifestyle Design Realty"
  - BCC to Peter
  - CAN-SPAM footer with unsubscribe and physical address
  - Uses claude-sonnet-4-6 via ANTHROPIC_API_KEY

Trigger: FUB tag "Seller Lead" present AND lead is in configured pond
Suppression: All existing suppression rules EXCEPT "DNC" tag (email-only track, DNC only blocks non-email)
Reply Handling: Stop sequence, tag "Seller-Replied" in FUB, include in Monday digest
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import re
import textwrap
from datetime import timezone
from typing import Any, Dict, List, Optional, Tuple

LOGGER = logging.getLogger("fub_automation.seller_nurture")

# ── Seller Sequence Schedule ──────────────────────────────────────────────────
# Maps email_number (0-indexed) to the minimum days since enrollment before sending.
SELLER_SEQUENCE_SCHEDULE = {
    0: 0,    # Email 1: immediately on enrollment (day 0)
    1: 4,    # Email 2: day 4
    2: 10,   # Email 3: day 10
    3: 18,   # Email 4: day 18
    4: 30,   # Email 5: day 30
}
SELLER_SEQUENCE_LENGTH = 5
SELLER_MONTHLY_CADENCE_DAYS = 30  # After sequence completes, monthly updates

# ── Seller Tag Constants ──────────────────────────────────────────────────────
SELLER_LEAD_TAG = "seller lead"
SELLER_REPLIED_TAG = "Seller-Replied"
SELLER_NURTURE_AUDIT_ACTION = "seller_nurture"

# ── Suppression tags for seller track ─────────────────────────────────────────
# Same as buyer track EXCEPT "dnc" is NOT included (email-only track, DNC only blocks non-email)
SELLER_SUPPRESS_TAGS = {
    "do not contact", "do not nurture", "no ai email", "do not email",
    "email opt out", "unsubscribe", "unsubscribed", "bounced", "manual review",
    "opt out", "spam", "realtor", "agent", "annual nurture only", "replied - paused",
    "seller-replied",  # Our own reply tag stops the sequence
}


def extract_property_address_from_notes(notes: List[dict]) -> Tuple[str, str]:
    """Extract property address and neighborhood from FUB notes.
    
    Returns (address, neighborhood) tuple. Either or both may be empty string.
    Looks for common patterns like:
      - "Address: 123 Main St"
      - "Property: 123 Main St, San Antonio"
      - Street address patterns in note body
    """
    address = ""
    neighborhood = ""
    
    # Common address patterns in FUB notes
    address_patterns = [
        r"(?:address|property|home|house|listing)\s*[:=]\s*(.+?)(?:\n|$)",
        r"(\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Ave|Blvd|Dr|Ln|Rd|Way|Ct|Pl|Cir|Ter|Loop|Trail|Pass|Run|Cv|Pkwy|Hwy)\.?(?:\s*,\s*[A-Za-z\s]+)?)",
    ]
    
    for note in notes[:15]:
        raw = str(note.get("body") or note.get("text") or note.get("note") or "")
        cleaned = re.sub(r"<[^>]+>", " ", raw)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        
        if not cleaned:
            continue
            
        for pattern in address_patterns:
            match = re.search(pattern, cleaned, re.IGNORECASE)
            if match:
                candidate = match.group(1).strip().rstrip(".,;")
                # Basic validation: must have at least a number and a word
                if re.search(r"\d+\s+\w+", candidate) and len(candidate) > 8:
                    address = candidate[:200]
                    break
        if address:
            break
    
    # Try to extract neighborhood/area from address or notes
    if address:
        # Look for city/neighborhood after comma
        parts = address.split(",")
        if len(parts) > 1:
            neighborhood = parts[1].strip()
    
    if not neighborhood:
        # Look for neighborhood mentions in notes
        neighborhood_patterns = [
            r"(?:neighborhood|area|community|subdivision|addition)\s*[:=]\s*(.+?)(?:\n|$)",
            r"(?:interested in|looking at|lives in|located in)\s+(.+?)(?:\n|$|\.)",
        ]
        for note in notes[:10]:
            raw = str(note.get("body") or note.get("text") or note.get("note") or "")
            cleaned = re.sub(r"<[^>]+>", " ", raw).strip()
            for pattern in neighborhood_patterns:
                match = re.search(pattern, cleaned, re.IGNORECASE)
                if match:
                    neighborhood = match.group(1).strip().rstrip(".,;")[:100]
                    break
            if neighborhood:
                break
    
    return address, neighborhood


def generate_seller_email(
    llm_call_fn,
    person: dict,
    email_number: int,
    property_address: str,
    neighborhood: str,
    notes_context: str,
    rules,
) -> dict:
    """Generate a seller nurture email using Claude.
    
    Args:
        llm_call_fn: The _llm_call method from ContentGenerator
        person: FUB person dict
        email_number: 0-indexed email number in the sequence (0-4 for sequence, 5+ for monthly)
        property_address: Extracted property address (may be empty)
        neighborhood: Extracted neighborhood name (may be empty)
        notes_context: Formatted FUB notes for context
        rules: Rules object with company_name, etc.
    
    Returns:
        dict with keys: subject, email_body
    """
    first_name = person.get("firstName") or "there"
    person_id = int(person.get("id") or 0)
    today_str = dt.datetime.now(timezone.utc).strftime('%Y-%m-%d')
    
    # Location context for personalization
    location_context = ""
    if property_address and neighborhood:
        location_context = f"Their property address is: {property_address} (neighborhood: {neighborhood}). Use this to personalize the email with local context."
    elif property_address:
        location_context = f"Their property address is: {property_address}. Use this to personalize the email with local context."
    elif neighborhood:
        location_context = f"Their neighborhood/area is: {neighborhood}. Use this to personalize the email with local context."
    else:
        location_context = "No specific property address or neighborhood is known. Keep the email general about their home and the local Texas market."

    # Email-specific angle and instructions
    if email_number == 0:
        email_angle = "FREE HOME VALUE / EQUITY REPORT OFFER"
        email_instruction = (
            "This is the FIRST email in the seller nurture sequence. "
            "Offer a free, no-obligation home value estimate or equity report. "
            "Keep it casual, short, and zero-pressure. Something like 'I put together free home value reports for homeowners in the area — "
            "would you like me to run one for your place? No strings attached.' "
            "Make it feel like a friendly offer, not a sales pitch. "
            "Do NOT mention selling, listing, or agents. Just offer the free report as a helpful resource."
        )
    elif email_number == 1:
        email_angle = "NEIGHBORHOOD MARKET UPDATE"
        email_instruction = (
            "This is a neighborhood market update email. "
            "Share that homes have been selling recently in their area and what that means for their property's value. "
            "Reference the neighborhood or area if known. Talk about recent activity (homes sold, days on market, price trends) "
            "in general terms — do NOT invent specific statistics or exact numbers unless provided. "
            "The tone should be informational and helpful — 'thought you'd want to know what's happening in your neighborhood.' "
            "End with a soft question like 'curious what your place might be worth in this market?'"
        )
    elif email_number == 2:
        email_angle = "EQUITY ANGLE — MOST HOMEOWNERS DON'T REALIZE"
        email_instruction = (
            "This email uses the angle: 'Most homeowners don't realize how much equity they're sitting on.' "
            "Share the concept that many homeowners are surprised by how much their home has appreciated. "
            "Mention that even if they're not thinking about selling, it's good to know where they stand. "
            "Soft CTA: offer to put together a custom equity report if they'd like to see the numbers. "
            "Keep it educational and curiosity-driven, not pushy."
        )
    elif email_number == 3:
        email_angle = "CASE STUDY — HELPED A LOCAL HOMEOWNER SELL ABOVE ASKING"
        email_instruction = (
            "This email shares a brief case-study style story about helping a local homeowner sell above asking price. "
            "Keep it vague enough to protect privacy — do NOT use real names or exact addresses. "
            "Something like 'I recently helped a homeowner in [area] sell for $X above asking in just Y days.' "
            "The point is social proof — show that you deliver results for sellers in their area. "
            "End with a casual offer to chat if they ever want to explore their options. "
            "Do NOT pressure them to list. Just plant the seed."
        )
    elif email_number == 4:
        email_angle = "CHECK-IN — NO RUSH, HERE WHENEVER"
        email_instruction = (
            "This is the FINAL email in the initial sequence. "
            "Keep it short and warm — a simple check-in that says 'no rush, no pressure, I'm here whenever you're ready.' "
            "Acknowledge that selling is a big decision and there's no timeline. "
            "Leave the door wide open — 'whether it's next month or next year, I'm happy to help when the time is right.' "
            "This should feel like a friend saying 'I've got your back' — not a salesperson following up."
        )
    else:
        # Monthly market update (post-sequence)
        cycle_seed = f"{person_id}-seller-monthly-{email_number}-{dt.datetime.now(timezone.utc).strftime('%Y-%m')}"
        seed_hash = int(hashlib.sha256(cycle_seed.encode('utf-8')).hexdigest(), 16)
        monthly_angles = [
            "quick local market pulse — what's selling in their area and what it means for their home value",
            "seasonal market insight — how the current season affects home values and buyer demand",
            "neighborhood spotlight — recent sales activity and what's trending in their area",
            "home equity check-in — a friendly reminder that their home value may have changed",
            "market conditions update — inventory, buyer demand, and what it means for homeowners",
        ]
        angle = monthly_angles[seed_hash % len(monthly_angles)]
        email_angle = f"MONTHLY MARKET UPDATE: {angle}"
        email_instruction = (
            f"This is a monthly market update for a seller lead (email #{email_number + 1} in the ongoing nurture). "
            f"Focus on: {angle}. "
            "Keep it informational, helpful, and low-pressure. "
            "Reference their neighborhood or area if known. "
            "End with a simple question or soft CTA — 'curious about your home's current value?' or similar. "
            "This should feel like a helpful market newsletter from a friend in real estate, not a sales pitch."
        )

    safe_notes = notes_context or "No recent notes available."

    prompt = f"""
    You are writing as Peter Allen from {rules.company_name}.
    Draft a warm, personal seller nurture email to a homeowner.

    Lead first name: {first_name}
    Today's date: {today_str}
    Email number in sequence: {email_number + 1}
    Email angle: {email_angle}
    Location context: {location_context}
    Recent FUB notes (for context only): {safe_notes}

    SPECIFIC INSTRUCTIONS FOR THIS EMAIL:
    {email_instruction}

    HARD RULES (MUST FOLLOW):
    - ABSOLUTELY NEVER reference divorce, foreclosure, financial hardship, debt, or any negative life circumstance.
    - ABSOLUTELY NEVER mention how you found them, where you got their info, or why you're reaching out (no "I noticed your home" or "I saw you might be interested in selling").
    - NEVER assume they want to sell. Treat them as a homeowner who might be curious about their home's value.
    - Every homeowner gets the same generic, friendly copy regardless of how they entered the system.
    - Personalize ONLY with property address/neighborhood where available — nothing else from their source or tags.

    STYLE REQUIREMENTS:
    - Make this feel like a one-off email Peter just wrote on his phone, not a drip, newsletter, or campaign.
    - Write in a highly personal, warm, casual, and human tone. Think real estate advisor talking to a neighbor.
    - Avoid run-on sentences. Break the text into very short, punchy paragraphs (max 2-3 sentences per paragraph).
    - Use emojis naturally (aim for 2 to 3 emojis such as 🏡, 📈, ✨, 💰, etc.).
    - CRITICAL STYLE RESTRICTION: Do NOT use dashes anywhere in the subject or body. Use commas, parentheses, or a new sentence instead.
    - CRITICAL STYLE RESTRICTION: Do NOT use bullet points, numbered lists, or list structures. Keep it strictly conversational prose.
    - Write exactly ONE greeting line at the top, for example "Hey {first_name},". Use only the first name.
    - The subject line must be specific and engaging. Do NOT use generic subjects like "Checking in" or "Quick question".
    - Keep it concise: 80 to 150 words, plain text, friendly, and specific enough to invite a reply.
    - Ask exactly one simple question that makes it easy for them to respond.
    - End with Peter's first name only. Do not add the company name, business address, legal disclaimer, or unsubscribe language (the system adds the footer separately).
    - Return strict JSON with exactly these keys: subject, email_body.
    """
    content = llm_call_fn(
        messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}],
        temperature=0.82,
    )
    if not content:
        raise ValueError("LLM returned empty seller nurture email")
    return json.loads(content)
