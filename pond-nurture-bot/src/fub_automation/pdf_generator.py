import os
import sys
import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch

def generate_deal_pdf(deal_info: dict, output_path: str, agent_name: str = "") -> str:
    """
    Generates a beautifully designed, high-end, branded PDF for a builder deal.
    agent_name: The first name of the agent (e.g. 'Stefanie') — shown in header and footer.
    """
    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        rightMargin=40,
        leftMargin=40,
        topMargin=40,
        bottomMargin=40
    )
    
    styles = getSampleStyleSheet()
    
    # Custom high-end styles
    primary_color = colors.HexColor("#0f172a") # Dark Slate / Navy
    secondary_color = colors.HexColor("#d97706") # Warm Gold / Amber
    text_color = colors.HexColor("#334155") # Muted Charcoal
    light_bg = colors.HexColor("#f8fafc") # Warm off-white
    
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=24,
        leading=28,
        textColor=primary_color,
        spaceAfter=6
    )
    
    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=14,
        textColor=secondary_color,
        spaceAfter=15
    )
    
    heading_style = ParagraphStyle(
        'SectionHeading',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=16,
        textColor=primary_color,
        spaceBefore=10,
        spaceAfter=8
    )
    
    body_style = ParagraphStyle(
        'BodyTextCustom',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=10,
        leading=14,
        textColor=text_color,
        spaceAfter=6
    )
    
    bullet_style = ParagraphStyle(
        'BulletCustom',
        parent=body_style,
        leftIndent=15,
        firstLineIndent=-10,
        spaceAfter=4
    )
    
    story = []
    
    # --- HEADER / BRANDING ---
    agent_display = f"{agent_name} | " if agent_name else ""
    header_data = [
        [
            Paragraph(
                f"<b>LIFESTYLE DESIGN REALTY</b><br/>"
                f"<font size='10' color='#d97706'>{agent_display}Your Exclusive Deal Sheet</font>",
                ParagraphStyle('LDR', fontName='Helvetica-Bold', fontSize=14, leading=18, textColor=primary_color)
            ),
            Paragraph(f"Date: {datetime.date.today().strftime('%B %d, %Y')}", ParagraphStyle('DateStyle', fontName='Helvetica', fontSize=9, leading=11, textColor=text_color, alignment=2))
        ]
    ]
    header_table = Table(header_data, colWidths=[4.0*inch, 3.5*inch])
    header_table.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 10),
    ]))
    story.append(header_table)
    
    # Divider Line
    divider = Table([[""]], colWidths=[7.5*inch])
    divider.setStyle(TableStyle([
        ('LINEABOVE', (0,0), (-1,-1), 1.5, primary_color),
        ('BOTTOMPADDING', (0,0), (-1,-1), 15),
    ]))
    story.append(divider)
    
    # --- TITLE & DEETS ---
    story.append(Paragraph(deal_info.get("title", "Exclusive Builder Deal Spotlight").upper(), title_style))
    story.append(Paragraph(f"📍 BUILDER: {deal_info.get('builder', 'Preferred Builder').upper()}  |  📍 COMMUNITY: {deal_info.get('community', 'San Antonio Area').upper()}  |  💰 STARTING AT: {deal_info.get('price_range', 'Low $300s')}", subtitle_style))
    
    # --- OVERVIEW HERO BOX ---
    overview_text = (
        f"<b>🧊 Deal Spotlight:</b> This is the kind of new build that makes people say 'Wait, that is the price?' "
        f"Featuring bright open layouts, clean modern finishes, and a floor plan that actually lives. "
        f"Located in a highly desirable school district with premium community amenities."
    )
    overview_table = Table([[Paragraph(overview_text, ParagraphStyle('Hero', parent=body_style, fontSize=11, leading=15, textColor=primary_color))]], colWidths=[7.5*inch])
    overview_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), light_bg),
        ('PADDING', (0,0), (-1,-1), 12),
        ('BOX', (0,0), (-1,-1), 1.0, secondary_color),
        ('BOTTOMPADDING', (0,0), (-1,-1), 15),
    ]))
    story.append(overview_table)
    story.append(Spacer(1, 15))
    
    # --- FEATURES & SPECS ---
    story.append(Paragraph("🏡 COMMUNITY SNAPSHOT & HOME FEATURES", heading_style))
    features = deal_info.get("features", [
        "Bright open layout, clean finishes, and flexible floor plans.",
        "One and two-story options with 3 to 5 bedrooms and flexible spaces.",
        "Modern kitchens with big windows, smart storage, and covered patios.",
        "Amenity center with pool, hangout zones, and recreation areas.",
        "Easy highway access for quick commutes, dining, and shopping."
    ])
    for feat in features:
        story.append(Paragraph(f"• {feat}", bullet_style))
        
    story.append(Spacer(1, 15))
    
    # --- BUYER WINS / INCENTIVES ---
    story.append(Paragraph("💸 EXCLUSIVE BUYER WINS & INCENTIVES", heading_style))
    wins = deal_info.get("buyer_wins", [
        "Zero down payment options available for qualified military/veteran buyers.",
        "Interest rates as low as 3.99% on select inventory with limited-time programs.",
        "VA, FHA, and Conventional friendly financing with flexible terms.",
        "Builder credit towards closing costs or interest rate buy-downs."
    ])
    for win in wins:
        story.append(Paragraph(f"🔥 {win}", bullet_style))
        
    story.append(Spacer(1, 15))
    
    # --- FINANCIAL ESTIMATES TABLE ---
    story.append(Paragraph("📊 ESTIMATED PAYMENT BREAKDOWN", heading_style))
    
    base_price = deal_info.get("base_price", "$311,000")
    upgrade_price = deal_info.get("upgrade_price", "$415,000")
    rate = deal_info.get("rate", "3.99%")
    
    table_data = [
        ["Home Option", "Base Pricing", "Premium / Upgraded Option"],
        ["Estimated Price", base_price, upgrade_price],
        ["Promotional Rate", rate, rate],
        ["Est. Monthly Payment (P&I)", deal_info.get("est_base_payment", "$1,480/mo"), deal_info.get("est_upgrade_payment", "$1,980/mo")],
        ["Incentives Included", "Standard Finishes", "Upgraded Finishes, Larger Lot"]
    ]
    
    fin_table = Table(table_data, colWidths=[2.5*inch, 2.5*inch, 2.5*inch])
    fin_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), primary_color),
        ('TEXTCOLOR', (0,0), (-1,0), colors.white),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,0), 10),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BACKGROUND', (0,1), (-1,-1), light_bg),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#cbd5e1")),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, light_bg]),
        ('PADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(fin_table)
    story.append(Spacer(1, 20))
    
    # --- CALL TO ACTION FOOTER ---
    agent_cta = f"Ask for <b>{agent_name}</b> — " if agent_name else ""
    cta_text = (
        "<b>📲 READY TO TOUR OR GET THE FULL LIST?</b><br/>"
        f"{agent_cta}Contact us to schedule a private walkthrough, get pre-approved in minutes, or receive "
        "a customized list of homes matching your exact budget and timeline.<br/>"
        f"<b>LIFESTYLE DESIGN REALTY</b>  |  📧 info@lifestyledesignrealty.com  |  🌐 lifestyledesignrealty.com"
    )
    cta_table = Table([[Paragraph(cta_text, ParagraphStyle('CTA', parent=body_style, fontSize=10, leading=14, textColor=colors.white, alignment=1))]], colWidths=[7.5*inch])
    cta_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), primary_color),
        ('PADDING', (0,0), (-1,-1), 12),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('BOX', (0,0), (-1,-1), 1.0, secondary_color),
    ]))
    story.append(cta_table)
    
    # Build PDF
    doc.build(story)
    return output_path

# Sample builder deals database to pull from based on current date / day of the week
DEALS_DATABASE = [
    {
        "id": "san_antonio_base_311",
        "title": "Exclusive San Antonio New Builds: Zero Down & 3.99% Rates!",
        "community": "Sorento & Horizon Pointe Communities (San Antonio Area)",
        "builder": "Lennar Homes",
        "price_range": "$311,000 - $415,000+",
        "base_price": "$311,000",
        "upgrade_price": "$415,000",
        "rate": "3.99%",
        "est_base_payment": "$1,480/mo",
        "est_upgrade_payment": "$1,980/mo",
        "features": [
            "Builder: Lennar Homes (Horizon Pointe Community)",
            "Homes start at $311,000 because that is the entry level base pricing for smaller plans on standard lots with standard finishes.",
            "The exact home in the video is in the low $400s because it is a larger plan and includes a bigger lot and premium upgrades.",
            "One and two-story options with 3 to 5 bedrooms and flexible spaces for office, gym, or guest setup.",
            "Modern kitchens with big windows, smart storage, and covered patio vibes.",
            "Amenity center energy with pool and hangout zones so weekends are handled.",
            "Easy highway access for smooth commutes and quick runs to shopping/dining."
        ],
        "buyer_wins": [
            "Zero down payment options available for qualified VA/military buyers.",
            "Interest rates as low as 3.99% on select homes with approved credit and limited-time programs.",
            "VA, FHA, and conventional friendly with options for closing cost help and rate buy-downs.",
            "Fast pre-approvals, side-by-side payment options, and clear numbers from hello to keys."
        ]
    },
    {
        "id": "austin_commute_349",
        "title": "Exclusive Austin Metro New Builds: Rates as low as 4.25%!",
        "community": "Leander & Georgetown Ranch Communities (Austin Metro)",
        "builder": "Pulte Homes",
        "price_range": "$349,000 - $450,000+",
        "base_price": "$349,000",
        "upgrade_price": "$450,000",
        "rate": "4.25%",
        "est_base_payment": "$1,720/mo",
        "est_upgrade_payment": "$2,210/mo",
        "features": [
            "Builder: Pulte Homes (Georgetown Ranch Community)",
            "Homes start at $349,000 for standard base plans on standard lots.",
            "Upgraded models with luxury finishes and larger lots are priced in the mid $450s.",
            "Spacious open-concept living rooms, gourmet kitchens, and energy-efficient appliances.",
            "Neighborhood park, playground, and scenic walking trails.",
            "Minutes from major employment hubs, tech centers, and local schools."
        ],
        "buyer_wins": [
            "Up to $15,000 in builder closing cost assistance on inventory homes.",
            "Interest rates starting at 4.25% with preferred builder lender programs.",
            "Conventional, FHA, and VA approved financing options.",
            "Free home design consultation and custom appliance packages included."
        ]
    },
    {
        "id": "dallas_north_399",
        "title": "Exclusive North Dallas Luxury New Builds: Rate Buy-downs Active!",
        "community": "Frisco & Prosper Ranch Communities (North Dallas Metro)",
        "builder": "Perry Homes",
        "price_range": "$399,000 - $520,000+",
        "base_price": "$399,000",
        "upgrade_price": "$520,000",
        "rate": "4.50%",
        "est_base_payment": "$2,020/mo",
        "est_upgrade_payment": "$2,630/mo",
        "features": [
            "Builder: Perry Homes (Frisco Lakes Community)",
            "Entry level base pricing starts at $399,000 for standard 3-bedroom models.",
            "Featured upgraded homes with luxury chef kitchens and covered patios are in the low $500s.",
            "Stunning high ceilings, luxury vinyl plank flooring, and smart home technology.",
            "Resort-style community pool, clubhouse, and dog park.",
            "Highly rated local school district with convenient access to major shopping centers."
        ],
        "buyer_wins": [
            "3-2-1 Interest Rate Buy-down programs available with builder's lender.",
            "Zero down USDA financing options available for qualified locations.",
            "Up to $10,000 in designer upgrade credits on select quick move-in homes.",
            "Full 1-2-10 year structural builder warranty included on all homes."
        ]
    }
]

def get_deal_for_city(city: str = "San Antonio") -> dict:
    """
    Returns a customized builder deal tailored specifically to the agent's target city/market.
    Supports San Antonio, Austin, and Dallas/DFW.
    """
    normalized_city = str(city).strip().lower()
    
    # Map cities to their respective deal in the database
    if any(keyword in normalized_city for keyword in ["austin", "leander", "georgetown", "cedar park"]):
        return DEALS_DATABASE[1]  # Austin deal
    elif any(keyword in normalized_city for keyword in ["dallas", "fort worth", "dfw", "plano", "frisco"]):
        return DEALS_DATABASE[2]  # Dallas/DFW deal
    else:
        return DEALS_DATABASE[0]  # San Antonio deal (default)

def get_deal_for_today() -> dict:
    """
    Returns the appropriate deal based on the current day of the week to keep content rotating.
    Kept for backward compatibility.
    """
    day = datetime.datetime.now().weekday()
    # Rotate between the 3 deals
    return DEALS_DATABASE[day % len(DEALS_DATABASE)]


def upload_pdf_to_storage(local_path: str, storage_key: str) -> str:
    """
    Uploads a PDF file to Manus S3 storage via the Forge presign API.
    Returns the /manus-storage/{key} URL served by the webdev proxy,
    or falls back to the local /pdf/ path if upload fails.

    Requires BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY env vars.
    """
    import os
    import requests as _req

    forge_url = os.environ.get("BUILT_IN_FORGE_API_URL", "").rstrip("/")
    forge_key = os.environ.get("BUILT_IN_FORGE_API_KEY", "")
    dashboard_base = "https://fub-nurture-phfprjui.manus.space"

    if not forge_url or not forge_key:
        # Fallback: serve from local /pdf/ path
        filename = os.path.basename(local_path)
        return f"{dashboard_base}/pdf/{filename}"

    try:
        # 1. Get presigned PUT URL
        presign_resp = _req.get(
            f"{forge_url}/v1/storage/presign/put",
            headers={"Authorization": f"Bearer {forge_key}"},
            params={"path": storage_key},
            timeout=10,
        )
        presign_resp.raise_for_status()
        s3_url = presign_resp.json().get("url", "")
        if not s3_url:
            raise ValueError("Empty presign URL returned")

        # 2. Upload PDF bytes directly to S3
        with open(local_path, "rb") as f:
            pdf_bytes = f.read()
        upload_resp = _req.put(
            s3_url,
            data=pdf_bytes,
            headers={"Content-Type": "application/pdf"},
            timeout=30,
        )
        upload_resp.raise_for_status()

        # 3. Return the manus-storage proxy URL
        return f"{dashboard_base}/manus-storage/{storage_key}"

    except Exception as exc:
        import logging
        logging.getLogger("fub_automation").warning(
            "PDF S3 upload failed for %s: %s — falling back to local path", local_path, exc
        )
        filename = os.path.basename(local_path)
        return f"{dashboard_base}/pdf/{filename}"
