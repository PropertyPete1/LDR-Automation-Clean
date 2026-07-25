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
  - Uses claude-haiku-4-5 via ANTHROPIC_API_KEY

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
SELLER_MONTHLY_CADENCE_DAYS = 30  # Legacy default; overridden by rules.seller_longtail_cadence_days (21 = every 3 weeks)

# ── Long-tail angle rotation (post day-30 email) ────────────────────────────
# Deterministic rotation keyed by how many long-tail emails have gone out, so
# the same angle can never repeat back-to-back for a lead (and survives
# restarts with no extra state — derived from emails_sent).
LONGTAIL_ANGLES = ["market_update", "equity_teaser", "case_study"]


def longtail_angle_for(emails_sent: int) -> str:
    """Return the long-tail angle for the next email given emails already sent.

    emails_sent >= SELLER_SEQUENCE_LENGTH (5). The first long-tail email
    (emails_sent == 5) gets market_update, then equity_teaser, case_study,
    market_update, … — strict rotation, never the same angle twice in a row.
    """
    idx = max(0, emails_sent - SELLER_SEQUENCE_LENGTH) % len(LONGTAIL_ANGLES)
    return LONGTAIL_ANGLES[idx]


def ramp_daily_cap(ramp: list, first_send_at: "Optional[dt.datetime]", now: "Optional[dt.datetime]" = None) -> int:
    """Resolve today's seller daily send cap from the weekly ramp schedule.

    ramp: e.g. [25, 25, 50, 50] — week 0 uses ramp[0], week 1 ramp[1], …
    then holds at the last value forever. Anchor = first seller nurture email
    ever sent (min enrolled_at). No anchor yet -> week 0.
    """
    if not ramp:
        return 25
    if first_send_at is None:
        return int(ramp[0])
    now = now or dt.datetime.now(timezone.utc)
    if first_send_at.tzinfo is None:
        first_send_at = first_send_at.replace(tzinfo=timezone.utc)
    weeks = max(0, (now - first_send_at).days // 7)
    return int(ramp[min(weeks, len(ramp) - 1)])

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
        # Long-tail nurture (post day-30 email): every 3 weeks, strict angle
        # rotation market_update -> equity_teaser -> case_study -> … so copy
        # never repeats back-to-back for the same lead.
        angle_key = longtail_angle_for(email_number)
        longtail_instructions = {
            "market_update": (
                "LOCAL MARKET UPDATE",
                "Share a quick local market pulse: what's been selling in their area, general "
                "trends in buyer demand or inventory, and what that means for their home's value. "
                "Do NOT invent specific statistics. Informational and helpful — 'thought you'd want "
                "to know what's happening in your neighborhood.' "
                "End with a soft question like 'curious what your place might be worth right now?'"
            ),
            "equity_teaser": (
                "EQUITY TEASER",
                "Use the angle that many homeowners are sitting on more equity than they realize, "
                "and home values in their area may have shifted since they last checked. "
                "Friendly reminder that knowing where they stand costs nothing. "
                "Soft CTA: offer to run a free, no-obligation equity report for their place."
            ),
            "case_study": (
                "LOCAL CASE STUDY",
                "Share a brief, privacy-safe story about recently helping a local homeowner get a "
                "great result (sold above asking, quick sale, smooth process). No real names or "
                "exact addresses. The point is quiet social proof. "
                "End with a casual, zero-pressure offer to chat whenever they're curious about their options."
            ),
        }
        angle_title, angle_instruction = longtail_instructions[angle_key]
        email_angle = f"LONG-TAIL NURTURE ({angle_key}): {angle_title}"
        email_instruction = (
            f"This is an ongoing long-tail nurture email for a seller lead (email #{email_number + 1} overall; "
            f"these go out every few weeks after the initial sequence). "
            f"{angle_instruction} "
            "Keep it informational, warm, and low-pressure — like a helpful note from a friend in real "
            "estate, never a sales pitch. Reference their neighborhood or area if known."
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


# ── Seller Email Signature ────────────────────────────────────────────────────
# This signature is appended ONLY to seller nurture track emails.
# Buyer sequences remain unchanged.

PETER_HEADSHOT_URL = "https://raw.githubusercontent.com/PropertyPete1/LDR-Automation-Clean/main/pond-nurture-bot/assets/peter_headshot.png"
# Verified 200 (application/pdf) 2026-07-24. The previous "IABS-2024.pdf"
# returned 404 — a dead regulatory-disclosure link on every seller email.
# If TREC renames it again, the stable landing page is
# https://www.trec.texas.gov/forms/information-about-brokerage-services
TREC_IABS_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/IABS%201-2_1.pdf"
TREC_CONSUMER_PROTECTION_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/CN%201-4-1_1.pdf"
INSTAGRAM_URL = "https://www.instagram.com/lifestyledesignrealtytexas/"
FACEBOOK_URL = "https://www.facebook.com/lifestyledesignrealty"
REFERRAL_URL = "https://lifestyledesignrealty.com"


def build_seller_email_html(body_text: str, rules) -> str:
    """Build the full HTML email for seller nurture with signature and CAN-SPAM footer.

    Structure:
      1. Email body (converted from plain text to HTML paragraphs)
      2. Peter Allen signature block (TREC links, headshot + contact info, social icons)
      3. CAN-SPAM footer (unsubscribe + physical address)

    This is used ONLY for seller nurture emails. Buyer sequences are untouched.
    """
    # Convert plain text body to HTML paragraphs
    paragraphs = body_text.strip().split("\n\n")
    body_html_parts = []
    for para in paragraphs:
        # Handle single newlines within a paragraph as <br>
        lines = para.strip().split("\n")
        body_html_parts.append(
            '<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;'
            f'line-height:1.5;color:#333333;">{("<br>".join(lines))}</p>'
        )
    body_html = "\n".join(body_html_parts)

    signature_html = f"""
<table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #cccccc;padding-top:16px;">
  <tr>
    <td colspan="2" style="padding-bottom:12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;">
      <a href="{TREC_IABS_URL}" style="color:#1a5276;text-decoration:none;">Information About Brokerage Services</a><br>
      <a href="{TREC_CONSUMER_PROTECTION_URL}" style="color:#1a5276;text-decoration:none;">TREC Consumer Protection Notice</a>
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;padding-right:14px;width:120px;">
      <img src="{PETER_HEADSHOT_URL}" alt="Peter Allen" width="120" style="display:block;border-radius:4px;width:120px;height:auto;" />
    </td>
    <td style="vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#333333;">
      <strong style="font-size:16px;color:#1a1a1a;">Peter Allen</strong><br>
      Lifestyle Design Realty, LLC<br>
      Managing Realtor and Owner<br>
      Army Veteran at your service<br>
      <br>
      C: <a href="tel:5203737839" style="color:#1a5276;text-decoration:none;">520.373.7839</a><br>
      E: <a href="mailto:Peter@lifestyledesignrealty.com" style="color:#1a5276;text-decoration:none;">Peter@lifestyledesignrealty.com</a><br>
      <a href="{REFERRAL_URL}" style="color:#1a5276;text-decoration:none;">Send this Link to a Friend [Click Here]</a><br>
      <br>
      1212 Chicon St, Suite 101<br>
      Austin, TX 78702
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding-top:12px;">
      <a href="{INSTAGRAM_URL}" style="text-decoration:none;margin-right:12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#1a5276;">&#x1F4F7; View my feed</a>
      <a href="{FACEBOOK_URL}" style="text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#1a5276;">&#x1F44D; Add me on Facebook</a>
    </td>
  </tr>
</table>
"""

    footer_html = f"""
<table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #eeeeee;padding-top:12px;width:100%;">
  <tr>
    <td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;color:#999999;">
      {rules.company_name}<br>
      {rules.company_address}<br><br>
      If you no longer want market updates from us, reply UNSUBSCRIBE and we will remove you from future marketing emails.
    </td>
  </tr>
</table>
"""

    full_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:20px;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
{body_html}
{signature_html}
{footer_html}
</body>
</html>"""

    return full_html


def build_seller_email_plaintext(body_text: str, rules) -> str:
    """Build the plain-text version of the seller nurture email with signature and footer.

    Structure:
      1. Email body (as-is)
      2. Peter Allen signature (plain text)
      3. CAN-SPAM footer

    This is the plain-text fallback for email clients that don't render HTML.
    """
    # Built from the same constants as the HTML signature so the two versions
    # cannot drift apart (they had already drifted once on the IABS link).
    signature_plain = f"""
---
Information About Brokerage Services: {TREC_IABS_URL}
TREC Consumer Protection Notice: {TREC_CONSUMER_PROTECTION_URL}

Peter Allen
Lifestyle Design Realty, LLC
Managing Realtor and Owner
Army Veteran at your service

C: 520.373.7839
E: Peter@lifestyledesignrealty.com
Send this Link to a Friend: https://lifestyledesignrealty.com

1212 Chicon St, Suite 101
Austin, TX 78702

Instagram: https://www.instagram.com/lifestyledesignrealtytexas/
Facebook: https://www.facebook.com/lifestyledesignrealty
"""

    footer_plain = f"""
--
{rules.company_name}
{rules.company_address}

If you no longer want market updates from us, reply UNSUBSCRIBE and we will remove you from future marketing emails.
"""

    return f"{body_text.strip()}\n{signature_plain}\n{footer_plain}"


# ── Bounce Fallback Rotation ─────────────────────────────────────────────────
# Tracks bounced email addresses per lead and rotates to the next available
# address on the FUB record. Only suppresses when ALL addresses are exhausted.

SELLER_BOUNCE_ROTATION_ACTION = "seller_bounce_rotation"


def get_all_lead_emails(person: dict) -> List[str]:
    """Extract all email addresses from a FUB person record, preserving order.
    
    Returns a deduplicated list of lowercase email addresses in the order
    they appear on the FUB record (emails[0] is primary).
    """
    emails_list = person.get("emails") or []
    seen: set = set()
    result: List[str] = []
    for email_dict in emails_list:
        if isinstance(email_dict, dict):
            val = (email_dict.get("value") or email_dict.get("email") or "").strip().lower()
            if val and val not in seen:
                seen.add(val)
                result.append(val)
    return result


def select_send_address(
    all_emails: List[str],
    bounced_addresses: List[str],
) -> Optional[str]:
    """Select the next valid email address for sending, skipping bounced ones.
    
    Args:
        all_emails: All email addresses on the FUB record (ordered, primary first)
        bounced_addresses: List of addresses known to have bounced for this lead
    
    Returns:
        The first non-bounced address, or None if all are exhausted.
    """
    bounced_set = {addr.lower() for addr in bounced_addresses}
    for email in all_emails:
        if email.lower() not in bounced_set:
            return email
    return None


def format_rotation_fub_note(
    bounced_email: str,
    new_email: Optional[str],
    total_addresses: int,
    exhausted: bool,
) -> Tuple[str, str]:
    """Format a FUB note documenting a bounce rotation event.
    
    Returns (subject, body) tuple for the FUB note.
    """
    if exhausted:
        subject = "📧 Seller Nurture: All Email Addresses Bounced"
        body = (
            f"The seller nurture email to \"{bounced_email}\" bounced (permanent delivery failure).\n\n"
            f"All {total_addresses} email address(es) on file have now bounced. "
            f"Lead is being suppressed from seller nurture until a valid email is added.\n\n"
            f"Action: Seller nurture sequence paused. Lead tagged 'bounced'."
        )
    else:
        subject = "📧 Seller Nurture: Email Bounced — Rotated to Next Address"
        body = (
            f"The seller nurture email to \"{bounced_email}\" bounced (permanent delivery failure).\n\n"
            f"Rotating to next address on file: \"{new_email}\"\n"
            f"({total_addresses} total address(es) on record)\n\n"
            f"Action: Next seller nurture email will be sent to the new address."
        )
    return subject, body
