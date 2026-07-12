/**
 * SMS generation helpers — TypeScript port of fub_automation/src/fub_automation/sms_helpers.py
 * Generates personalized SMS messages for the Power Queue and builds redirect links.
 */

/** Derive a deterministic variety seed from lead ID and today's date */
function getVarietySeed(leadId: string | number): number {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${today.getMonth()}${today.getDate()}`;
  const combined = String(leadId) + dateStr;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Properly title-case every word in a name string */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Extract and title-case just the first name from a full name */
export function extractFirstName(fullName: string): string {
  const first = (fullName || "").trim().split(/\s+/)[0] || "there";
  return titleCase(first);
}

export function generatePersonalizedSms(
  firstName: string,
  city: string,
  daysStale: number,
  directAsk = false,
  leadId: string | number = "0"
): string {
  const firstNameCap = titleCase(firstName || "there");
  const cityCap = titleCase(city || "Texas");
  const seed = getVarietySeed(leadId);

  // Very stale leads (>7 days) get a direct-ask message
  if (directAsk || daysStale > 7) {
    const directAskTemplates = [
      `Hey ${firstNameCap}, are you still looking to purchase a home? 🏡`,
      `Hey ${firstNameCap}, just checking in — still thinking about buying in ${cityCap}? 😊`,
      `Hey ${firstNameCap}, hope you're doing well! Has your timeline shifted?`,
    ];
    return directAskTemplates[seed % directAskTemplates.length];
  }

  const weekday = new Date().getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const dayTemplates: Record<number, string[]> = {
    0: [
      `Hey ${firstNameCap}, hope you are having a peaceful Sunday! ☕ Just sending a quick text to see if you are still looking to buy a home in ${cityCap} sometime soon?`,
      `Hey ${firstNameCap}, hope you're having a wonderful weekend! Just checking in to see if you are still looking for a place in ${cityCap} or if your plans have shifted? 😊`,
      `Hey ${firstNameCap}, happy Sunday! Hope you have a great day. Just wanted to see if you are still thinking about finding a home in ${cityCap}? 🏡✨`,
    ],
    1: [
      `Hey ${firstNameCap}, happy Monday! Starting the week fresh, just wanted to see if you got a free sec to chat about homes in ${cityCap} sometime soon? 😊`,
      `Hey ${firstNameCap}, hope your week is starting off great! Just wanted to check in and see if you are still thinking about finding a place in ${cityCap}? 🏡☕`,
      `Hey ${firstNameCap}, hope you had a great weekend! Just checking in — has your timeline shifted?`,
    ],
    2: [
      `Hey ${firstNameCap}, hope you're having a great Tuesday! Are you still looking for a place in ${cityCap} or are you holding off for now? 🏡☀️`,
      `Hey ${firstNameCap}, hope your week is going well! Just checking in to see if you had any questions about the ${cityCap} market or any specific homes? 😊`,
      `Hey ${firstNameCap}, happy Tuesday! Just wanted to send a quick text to see if you are still looking at homes in ${cityCap}? 🏡✨`,
    ],
    3: [
      `Hey ${firstNameCap}, happy hump day! Hope your week is going great. Just wanted to see if you are still looking at homes in ${cityCap} or if you've already found something? 😊`,
      `Hey ${firstNameCap}, happy Wednesday! Just checking in to see if you got a chance to look over those homes in ${cityCap} lately? 🏡☕`,
      `Hey ${firstNameCap}, hope your week is going awesome! Are you still thinking about finding a home in ${cityCap} or has your timeline changed? ✨`,
    ],
    4: [
      `Hey ${firstNameCap}, hope you're having a great Thursday! Just wanted to reach out and see if you are still thinking about finding a place in ${cityCap}? 🏡✨`,
      `Hey ${firstNameCap}, hope your week has been great! Are you still looking to buy a home in ${cityCap} sometime soon, or is your timeline further out? 😊`,
      `Hey ${firstNameCap}, happy Thursday! Just sending a quick check-in to see if you are still looking at homes in ${cityCap} or if your plans have shifted? 🏡☕`,
    ],
    5: [
      `Hey ${firstNameCap}, happy Friday! Hope you have an amazing weekend ahead. ☀️ Are you still looking for a home in ${cityCap} or has your timeline shifted?`,
      `Hey ${firstNameCap}, happy Friday! Hope you've had a great week. Just wanted to see if you have any free time this weekend to look at some homes in ${cityCap}? 🏡✨`,
      `Hey ${firstNameCap}, happy Friday! Just wanted to send a quick text to see if you are still thinking about finding a place in ${cityCap}? Hope you have a wonderful weekend! 😊`,
    ],
    6: [
      `Hey ${firstNameCap}, hope you're having a wonderful Saturday! ☀️ Just wanted to check in and see if you're still looking for a home in ${cityCap} or if you are all set?`,
      `Hey ${firstNameCap}, happy weekend! Hope you're having an amazing Saturday. Just wanted to see if you are still thinking about finding a place in ${cityCap}? 🏡✨`,
      `Hey ${firstNameCap}, hope you're having a great weekend! ☀️ Are you still looking at homes in ${cityCap} or has your timeline changed a bit?`,
    ],
  };

  const templates = dayTemplates[weekday] ?? dayTemplates[1];
  return templates[seed % templates.length];
}

const DASHBOARD_BASE_URL = "https://lifestyledash-wpnl8v84.manus.space";

export function makeSmsUri(phone: string, body: string, agentName?: string, leadId?: string): string {
  // Normalise phone number
  let cleanPhone = phone.replace(/[^\d+]/g, "");
  if (!cleanPhone.startsWith("+") && cleanPhone.length === 10) {
    cleanPhone = "+1" + cleanPhone;
  }
  const encodedPhone = encodeURIComponent(cleanPhone);
  const encodedBody = encodeURIComponent(body);
  let url = `${DASHBOARD_BASE_URL}/sms-redirect?phone=${encodedPhone}&body=${encodedBody}`;
  if (agentName) {
    url += `&agent=${encodeURIComponent(agentName)}`;
  }
  if (leadId) {
    url += `&lead_id=${encodeURIComponent(leadId)}`;
  }
  return url;
}
