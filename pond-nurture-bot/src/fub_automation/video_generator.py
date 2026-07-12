import os
import datetime
try:
    from fub_automation.pdf_generator import get_deal_for_city
except ModuleNotFoundError:
    from src.fub_automation.pdf_generator import get_deal_for_city

def generate_video_script_and_caption(agent_name: str, city: str = "San Antonio") -> dict:
    """
    Generates a daily up-to-date video script and high-converting caption for the agent to post.
    """
    deal = get_deal_for_city(city)
    
    # Format prices and rates based on the deal
    base_price = deal.get("base_price", "$311,000")
    upgrade_price = deal.get("upgrade_price", "$415,000")
    rate = deal.get("rate", "3.99%")
    community = deal.get("community", "San Antonio Area")
    
    # 1. 30-Second Video Script (with pacing and instructions)
    script = f"""<b>🎥 30-SECOND VIDEO SCRIPT (Read with high energy!)</b><br/>
<b>[0:00 - 0:05] HOOK:</b> <i>(Point at the screen, show the gorgeous new build kitchen/interior. Ensure your video has a subtle <b>'Lifestyle Design Realty'</b> watermark on screen!)</i><br/>
"Stop scrolling! I'm {agent_name} with Lifestyle Design Realty, and this is the kind of new construction home in the {city} area that makes people say... wait, is that actually the price?!"<br/><br/>

<b>[0:05 - 0:15] THE DEAL:</b> <i>(Walk through the living room or show the master suite)</i><br/>
"These brand new homes start at just {base_price}! Yes, that is the entry level base price. Now, the exact upgraded model I am showing you in this video is in the low {upgrade_price}s because it is a larger layout with all the premium finishes."<br/><br/>

<b>[0:15 - 0:25] THE WINS:</b> <i>(Show the covered patio or community pool)</i><br/>
"But here is the real win: you can get into these with <b>ZERO DOWN</b> options if you qualify, and interest rates are starting as low as <b>{rate}</b>! Plus, there are amazing neighborhood amenities like a resort-style pool."<br/><br/>

<b>[0:25 - 0:30] CALL TO ACTION (CTA):</b> <i>(Look directly at the camera, smile)</i><br/>
"Don't miss out on this. <b>Comment HOME below</b> and I will instantly DM you today's available inventory, exact monthly payments, and builder incentives!"
"""

    # 2. High-Converting Caption (based on Peter's exact winning template)
    caption = f"""🧊 this is the kind of new build that makes people say wait that is the price
🪟 bright open layout clean finishes and a floor plan that actually lives

🏡 community snapshot
💰 homes start at {base_price} because that is the entry level base pricing for the smaller floor plans on standard lots with builder standard finishes and without upgrades
🏠 the exact home in my video is in the low {upgrade_price}s because it is a larger plan and typically includes a bigger lot and more upgrades like extra rooms and premium finish options 🔥
📐 one and two story options with 3 to 5 bedrooms and flexible space for office gym or guest setup
✨ modern kitchens big windows smart storage and covered patio vibes on select plans

🌳 lifestyle perks
🏊 amenity center energy with pool and hangout zones so weekends are handled
🛣 easy highway access for smooth commutes and quick runs to shopping dining and weekend plans
🎓 schools nearby so day to day life stays simple

💸 buyer wins
🇺🇸 zero down options available for qualified buyers
🔥 rates as low as {rate} on select homes with approved credit and limited time programs
✅ VA FHA and conventional friendly with options for closing cost help and rate buy downs when available
⚡ fast pre approvals side by side payment options and clear numbers from hello to keys

	📲 comment HOME and I will DM you today’s available homes with exact payments incentives and tour times
	📩 or DM LIST for a private lineup tailored to your budget and move date — {agent_name}, Lifestyle Design Realty

#veteran #military #texas #{city.lower().replace(" ", "")} #realestate"""

    return {
        "script": script,
        "caption": caption,
        "keyword": "HOME",
        "deal_id": deal["id"],
        "deal_title": deal["title"]
    }
