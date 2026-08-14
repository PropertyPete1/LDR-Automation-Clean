# PRIMARY Sales Site Audit — lifestyledesigntechnologies.com

**Audited:** 2026-08-13 (night of 8/13 → 8/14 UTC)
**Live URL tested:** https://lifestyle-te-nebjtuzn.manus.space/ (rendered with headless Chromium at 1440 / 768 / 390 px)
**Custom domain:** went live mid-audit (2026-08-14 ~03:34 UTC). `https://lifestyledesigntechnologies.com/` serves the site (200); `www` 301-redirects to the apex. **The apex is the canonical URL — use it in every link you send.** Note the page's own og:url/canonical/og:image still point at `www.`, which now bounces through a redirect; the Manus prompt below moves them to the apex.

**Method:** real rendered audit — full-page and per-section screenshots at three widths, every link and button clicked and recorded, both forms submitted end-to-end with network capture (test data marked `TEST AUDIT — IGNORE`; two test leads + one status probe went into FUB — delete them), Lighthouse mobile on simulated 4G, meta/OG inspection, and a line-by-line diff of site pricing against the "PRIMARY + Lifestyle Design Technologies — full system breakdown & pricing" email sent to Steven 8/13.

---

## Verdict

**Overall: 6/10 — do not text this link to a broker yet.** The skeleton is genuinely good: the hero is clear, pricing is clean and matches the Steven email exactly, both forms actually deliver leads (`POST /api/lead` → `200 {"ok":true}` → real success state), and the copy voice is confident operator, not AI mush. What sinks it are five fixable blockers: there is **no phone number anywhere on the page**, the three social icons link to **blank instagram.com/facebook.com/linkedin.com homepages**, a texted link shows **no preview card at all** (og:image is an SVG hosted on the dead custom domain), the signup form **silently does nothing** if a broker skips email/phone, and the **TREC/brokerage/veteran compliance block is missing entirely**. Fix the blocker list and this is a 9.

## Score table

| # | Axis | Score | One-line evidence |
|---|------|-------|-------------------|
| 1 | First 5 seconds | **8/10** | "Meet PRIMARY. / Your brokerage's brain." + a subhead that says what/who/when — clear, not clever. Docked for "Priced for growth" (vague) and the 4G reality that the hero takes ~5s to paint. `evidence/desktop-hero.jpg` |
| 2 | Buy path | **6/10** | One obvious step (demo) with a consistent skip-path; both forms POST to `/api/lead` and return real success states. But: no phone/text option anywhere, and a name-only submit fails silently — no error, no POST, dead button. |
| 3 | Proof | **4/10** | Origin story reads well, but zero receipts: not a single real number (the email to Steven has 4,400+ contacts, 150 emails/day), **zero screenshots of the actual product** (there are no `<img>` tags on the whole page), and three repeated "RESERVED FOR A FOUNDING CLIENT" placeholder cards that make the section look emptier than saying nothing. `evidence/desktop-section-proof.jpg` |
| 4 | Pricing clarity | **9/10** | One read, three tiers, matches the Steven email to the dollar (Presence $495+$149, Engine $1,500+$395, Command $5,000+$600, IDX +$100, all four add-ons, founding 25%). Docked only for "the big names charge $500+/mo" being vaguer than the email's Luxury Presence figure. `evidence/desktop-section-pricing.jpg` |
| 5 | Trust / compliance | **3/10** | No TREC IABS link, no Consumer Protection Notice, no "Lifestyle Design Realty, LLC" identity, no veteran-owned line — all of which sit in your own email signature. Social icons are dead placeholder links. On the plus side: no illegal overpromises (no "guaranteed leads"), and the approval-gated language is genuinely good. "AND IT NEVER LIES" is the one line to soften. |
| 6 | Mobile (390px) | **7/10** | No horizontal scroll, menu/pricing/forms all clean. Docked: hero "LIVE" caption collides with the SCROLL indicator (`evidence/mobile-hero.jpg`, bottom), pinch-zoom is disabled (`maximum-scale=1` — Lighthouse a11y fail), and nav/footer links are 14–17px tall (tap targets should be ≥44px). |
| 7 | Speed + share preview | **3/10** | Lighthouse mobile perf **52**: FCP 4.7s, LCP 5.8s on simulated 4G. Share preview: **none** — og:image is `og-primary.svg` (SVG — iMessage/Slack/FB won't render it) hosted on `www.lifestyledesigntechnologies.com` which doesn't even serve TLS yet. A texted link today = bare URL, no card. |
| 8 | Copy quality | **8/10** | Best-in-class for this genre: "Tested where it costs something to be wrong", "Bring a skeptic", "Distance is destiny", FAQ answers land ("Yes. British accent included."). Docked for "AND IT NEVER LIES" (overclaim — invite for the one demo where it's wrong), "Priced for growth", and empty-feeling placeholder testimonials. |

**Working:** all 9 nav anchors scroll correctly on desktop and in the mobile menu; all three tier CTAs and the three "READY NOW?" links target the signup section with tier context; demo form success state ("You're on the floor… expect a call from a human within one business day") and signup success state (3-step what-happens-next) both render; proof counters animate to 5 min / 7:05 / 24/7 once scrolled into view; `mailto:` goes to the correct address; SEO content is fully present in the prerendered HTML (Lighthouse SEO 100).

---

## Ranked fix list

### Blockers (don't send the link to a broker before these)

1. **No phone number on the entire page.** Brokers text and call; your email signature has 520.373.7839 but the site's only contact is a mailto link buried in the footer. A broker who won't fill a form has literally no path. → Add call/text line to the demo section + footer (copy below), as `tel:` and `sms:` links.
2. **Silent form failure.** Signup with name only (no email, no phone): no POST fires, no validation message appears, nothing happens — the button is dead. A hot lead who skips fields concludes the site is broken. → Require email + (phone or email), show an inline error, and mark required fields. Same treatment on both forms.
3. **Dead social links.** Instagram/Facebook/LinkedIn icons link to the platforms' bare homepages. To a skeptical broker this is the tell that the whole site is a facade. → Point at real profiles or delete the icons. (Real IG from your signature: `instagram.com/Lifestyledesignrealtytexas`.)
4. **No share preview card.** og:image is an SVG — most platforms (iMessage, Facebook, Slack, LinkedIn) won't render SVG previews — and it points at `www.`, which now 301s to the apex (some crawlers refuse redirected og assets). → 1200×630 PNG on `https://lifestyledesigntechnologies.com` (spec below), and move og:url/canonical to the apex too.
5. **Compliance block missing.** No TREC Information About Brokerage Services, no TREC Consumer Protection Notice, no Lifestyle Design Realty LLC identity, no veteran-owned line. You already link the first two in every email you send; the sales site for a product "built inside a working Texas brokerage" must clear the same bar. → Footer block, copy + links below.
6. ~~Custom domain TLS dead~~ **Resolved mid-audit:** `lifestyledesigntechnologies.com` went live at ~03:34 UTC 8/14 and serves the site; www redirects to apex. Send the apex link.

### Major (costs deals, not clicks)

7. **Proof section has no receipts.** Swap the three commitment stats for real, verifiable numbers (copy below: 4,400+ contacts / 150 emails in a day / 0 invented numbers), and add 2–3 real product screenshots — THE FLOOR with the actual database, the 7:05 morning brief on a phone, the telemetry dashboard. Blur/redact client names. Claims without screenshots read as vapor to brokers who get pitched AI weekly.
8. **Three repeated placeholder testimonials.** One placeholder is honest and intriguing; three identical ones scream "nobody has bought this." → Collapse to a single card (copy below).
9. **Mobile perf 52 (LCP 5.8s on 4G).** The content is prerendered (good) — the paint is blocked by the Google Fonts stylesheet (3 families), two analytics scripts (Plausible + Umami — pick one), and `Cache-Control: no-store` on everything including hashed assets (kills repeat visits and bf-cache). Fix list is in the Manus prompt.

### Polish

10. Mobile hero: "LIVE — every dot…" caption overlaps the SCROLL indicator at 390px.
11. Remove `maximum-scale=1` from the viewport meta (pinch-zoom is blocked; straight Lighthouse accessibility fail).
12. Tap targets: header nav, footer links, and the three "READY NOW?" links are 14–17px tall — pad to ≥44px effective target.
13. A11y: `aria-hidden="true"` elements contain focusable descendants; one control's visible label doesn't match its accessible name (Lighthouse a11y 90).
14. "2 SPOTS REMAINING" — keep it true. The moment client #2 signs, this line must change same-day, or it becomes the lie that undercuts the "never lies" brand.
15. Add PNG favicon fallback (`favicon.svg` only today; some surfaces — Google results, iMessage — won't render SVG favicons).
16. Scroll-reveal sections start at opacity 0: fine live, but print/PDF and reduced-motion users can get blank sections. Ask Manus to respect `prefers-reduced-motion` and render visible-by-default without JS.

---

## Rewritten copy (paste-ready blocks)

**1. Hero subhead — replace the last sentence** ("Priced for growth."):
> Running live today.

(Full subhead then reads: "…answers to its name. Built inside a working Texas brokerage. Running live today.")

**2. "NEVER LIES" line (features section) — replace:**
> AND IT NEVER GUESSES — if PRIMARY can't verify a number, it says so. Every claim carries its evidence.

**3. Proof stats strip — replace the three stats** (5 min / 7:05 / 24/7 are commitments, not receipts; the numbers below are receipts, same 3-column layout):
> **4,400+** — CONTACTS LIVE ON THE FLOOR TODAY
> **150** — NURTURE EMAILS SENT IN ONE DAY — EVERY ONE LOGGED
> **0** — NUMBERS INVENTED. EVER.

**4. Testimonials — replace all three cards with one:**
> THIS SPACE IS EARNED, NOT WRITTEN. We publish a testimonial only after a client has run PRIMARY on their own floor and written it themselves. Two founding slots remain — the first names on this wall get 25% off for life.

**5. Engine comparison line — replace:**
> Compare: Luxury Presence charges $1,200 setup + $500/mo — for the website alone.

**6. Contact strip (new — demo section, under the form, and footer):**
> Prefer a human right now? Call or text Peter: **(520) 373-7839** — the same number a founding client gets.

**7. Compliance footer block (new):**
> Lifestyle Design Technologies is built and operated by the team behind **Lifestyle Design Realty, LLC** — a licensed Texas brokerage, San Antonio & Austin, TX. **Veteran-owned: founded by an Army veteran.**
> [TREC Information About Brokerage Services](https://drive.google.com/file/d/1DTDRFjzJJS_iD8aaNu8l4Wr3YmmR9zHe/view) · [TREC Consumer Protection Notice](https://drive.google.com/file/d/15IIuupvaYS8EqtQkwonKev8wp3sodNOU/view)

**8. Form validation error (new):**
> We need at least an email or a phone number to reach you — pick whichever you actually answer.

## OG image spec (fix #4)

- **File:** `og-primary.png`, exactly **1200×630**, < 300 KB, served from `https://lifestyledesigntechnologies.com/og-primary.png` (the apex is live and canonical — don't use `www`, it redirects).
- **Content:** navy (#071244) background matching the site, the green PRIMARY orb motif, text: "Meet PRIMARY." large, "Your brokerage's brain." beneath in the green italic, "LIFESTYLE DESIGN TECHNOLOGIES" small at the bottom. Keep all text inside a 1100×530 safe area (platforms crop edges).
- **Tags:** `og:image` → the absolute apex PNG URL; add `og:image:width` 1200, `og:image:height` 630, `og:image:type` image/png; keep `twitter:card` summary_large_image, point `twitter:image` at the same PNG; move `og:url` and the canonical link from `www` to the apex.

---

## The one message to send Manus

Everything below in one paste. Screenshots for item 6 you'll need to attach yourself (export from PRIMARY, redact client names).

```
Nine changes to the PRIMARY site. Copy in [brackets] is verbatim — paste exactly, keep all existing styling/layout unless stated.

1. CONTACT PATH — In the "Watch it wake up" demo section under the form, and again in the footer, add: [Prefer a human right now? Call or text Peter: (520) 373-7839 — the same number a founding client gets.] Make the number a tel:+15203737839 link and add a second "text" link using sms:+15203737839. 

2. FORM VALIDATION — On BOTH forms (demo + signup): require email, and accept phone as an alternative (at least one of email/phone must be present). When validation fails, show a visible inline error: [We need at least an email or a phone number to reach you — pick whichever you actually answer.] Right now submitting with only a name does nothing at all — no error, no request. Mark required fields visually.

3. SOCIAL LINKS — The footer Instagram/Facebook/LinkedIn icons currently link to instagram.com, facebook.com, linkedin.com homepages. Point Instagram at https://www.instagram.com/Lifestyledesignrealtytexas/ and REMOVE the Facebook and LinkedIn icons until we have real company pages.

4. COMPLIANCE FOOTER — Add a footer block above the copyright line: [Lifestyle Design Technologies is built and operated by the team behind Lifestyle Design Realty, LLC — a licensed Texas brokerage, San Antonio & Austin, TX. Veteran-owned: founded by an Army veteran.] Below it, two linked lines: "TREC Information About Brokerage Services" → https://drive.google.com/file/d/1DTDRFjzJJS_iD8aaNu8l4Wr3YmmR9zHe/view and "TREC Consumer Protection Notice" → https://drive.google.com/file/d/15IIuupvaYS8EqtQkwonKev8wp3sodNOU/view

5. SHARE PREVIEW — Replace og-primary.svg with a PNG: og-primary.png, exactly 1200x630, under 300KB. Same design language: #071244 navy background, the green PRIMARY orb, text "Meet PRIMARY." with "Your brokerage's brain." beneath it and "LIFESTYLE DESIGN TECHNOLOGIES" small at the bottom; keep text inside a 1100x530 centered safe area. Set og:image to https://lifestyledesigntechnologies.com/og-primary.png with og:image:width=1200, og:image:height=630, og:image:type=image/png, point twitter:image at the same file, and change og:url and the canonical link from www.lifestyledesigntechnologies.com to https://lifestyledesigntechnologies.com (the apex is live; www redirects). Also add a 32x32 PNG favicon alongside favicon.svg.

6. PROOF RECEIPTS — In the PROOF section, replace the three stat values/labels (currently "5 min / 7:05 / 24/7") with: [4,400+ | CONTACTS LIVE ON THE FLOOR TODAY], [150 | NURTURE EMAILS SENT IN ONE DAY — EVERY ONE LOGGED], [0 | NUMBERS INVENTED. EVER.] Then add an image row in this section with the 2–3 product screenshots I'm attaching (THE FLOOR live view, the 7:05 morning briefing on a phone, the telemetry dashboard) with captions, styled like the rest of the section.

7. TESTIMONIALS — Replace the three identical "RESERVED FOR A FOUNDING CLIENT" cards with ONE card: [THIS SPACE IS EARNED, NOT WRITTEN. We publish a testimonial only after a client has run PRIMARY on their own floor and written it themselves. Two founding slots remain — the first names on this wall get 25% off for life.]

8. COPY EDITS — (a) Hero subhead: replace only the final sentence "Priced for growth." with [Running live today.] so the subhead ends "…Built inside a working Texas brokerage. Running live today." (b) In the features section, replace the line beginning "AND IT NEVER LIES" with: [AND IT NEVER GUESSES — if PRIMARY can't verify a number, it says so. Every claim carries its evidence.] (c) In the ENGINE pricing card, replace "Compare: the big names charge $500+/mo for the website alone." with [Compare: Luxury Presence charges $1,200 setup + $500/mo — for the website alone.]

9. MOBILE + PERFORMANCE — (a) At 390px width the hero caption "LIVE — every dot on this screen…" overlaps the SCROLL indicator; add spacing so they never collide. (b) Remove maximum-scale=1 from the viewport meta so pinch-zoom works. (c) Make header/footer nav links and the "READY NOW? SKIP THE DEMO" links at least 44px tall tap targets on mobile. (d) Mobile LCP is 5.8s: self-host or preload the fonts (or cut to 2 families), remove one of the two analytics scripts (keep Plausible OR Umami, not both), and serve hashed /assets/* files with long-lived immutable cache headers instead of Cache-Control: no-store (keep no-store on the HTML document only). (e) Fix accessibility: no focusable elements inside aria-hidden containers, and make visible button labels match their accessible names. (f) Respect prefers-reduced-motion: scroll-reveal sections should render visible without animation for those users.
```

---

## Evidence index

| File | Shows |
|------|-------|
| `evidence/desktop-hero.jpg` | Hero at 1440px — the good first 5 seconds |
| `evidence/mobile-hero.jpg` | 390px hero — caption/SCROLL collision at bottom |
| `evidence/desktop-full.jpg` | Full-page capture — everything below hero blank (scroll-reveal at opacity 0) |
| `evidence/desktop-section-floor.jpg` | THE FLOOR section |
| `evidence/desktop-section-proof.jpg` | Proof section: commitment stats + 3 placeholder testimonials |
| `evidence/desktop-section-pricing.jpg` | Pricing tiers (matches Steven email) |
| `evidence/mobile-section-pricing.jpg` | Pricing at 390px — clean |
| `evidence/desktop-section-demo.jpg` | Demo form — note: no phone number anywhere |
| `evidence/desktop-demo-after-submit.jpg` | Demo form success state ("You're on the floor.") |
| `evidence/desktop-signup-after-submit.jpg` | Signup success state (3-step next actions) |
| `evidence/desktop-faq-open.jpg` | FAQ open state |
| `evidence/mobile-menu.jpg` | Mobile nav menu |
| `evidence/mobile-section-signup.jpg` | Signup at 390px |

**Form test artifacts:** two leads named `TEST AUDIT — IGNORE` and one `TEST AUDIT — IGNORE (status probe)` were created in FUB (tagged "Primary Client" per the pipeline) around 03:20–03:30 UTC 8/14 — delete them.

**Lighthouse (mobile, simulated 4G):** Performance 52 · Accessibility 90 · Best Practices 82 · SEO 100. FCP 4.7s · LCP 5.8s · TBT 460ms · CLS 0 · total weight 431 KiB.

## Sweep notes (fixes re-checked against the rendered layout)

- Proof receipts (fix 6) reuse the existing 3-column stat layout — value + label swap only, no layout change. "150 in one day" phrasing stays true regardless of the day it's read, unlike "yesterday."
- The single testimonial card (fix 7) replaces a 3-card grid; card content is one sentence longer than the current placeholder and fits the existing card width at both 1440 and 390.
- The contact strip (fix 1) deliberately does NOT add a fourth hero button — the hero's three CTAs are already at capacity on mobile (they stack full-width). Demo section + footer are the natural homes.
- Hero subhead edit (fix 8a) was originally a longer replacement that would have duplicated "Built inside a working Texas brokerage" (it already appears mid-subhead) — caught in this sweep and reduced to swapping just the final sentence. Net length change is −1 word: zero wrap risk at 390px.
- Luxury Presence comparison (fix 8c) matches the figure in the Steven email; it's a truthful, verifiable public price — stronger than "big names" and safe.
- "2 SPOTS REMAINING" (polish 14) stays consistent with the new testimonial card's "Two founding slots remain" — if one changes, both must.
- No fix conflicts with another section; a cold re-read of all eight axes against these fixes surfaced no new issues.
