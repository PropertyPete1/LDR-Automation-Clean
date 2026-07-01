# BUG: Mobile shows "No picks available yet" (Jul 1, recurring)

Screenshot: app shell renders (header/nav visible) but picks.today returns empty on phone.

- [x] DB: today (2026-07-01) HAS picks (SA + Austin)
- [x] picks.today returns 200 with 2 picks in 528ms; auth.me shows Peter Allen/admin — data + auth are fine
- [x] Root cause: phone rendered a STALE cached JS bundle (empty state) from before today's picks/redeploy; UI collapses error+empty into the same dead-end message
- [x] Home: distinguish query ERROR (isError -> Retry) from genuinely EMPTY (-> Refresh); no more collapsed dead-end
- [x] Add useBuildFreshness hook: checks /__manus__/version.json on load + tab focus; one-time hard reload when deployed version changes (kills stale bundle)
- [x] refetchOnWindowFocus + refetchOnReconnect + retry:2 so returning to the PWA recovers automatically
- [x] Type-check clean + 64 tests pass
- [ ] User publishes; verify on phone (should self-recover even from a stale cache)

## REAL ROOT CAUSE (Jul 1, round 2) — mobile-only 401 on picks.today
- [x] Confirmed on prod: auth.me returns 200 (public), picks.today returns 401 UNAUTHORIZED when no credential
- [x] Confirmed: picks.today only authenticates via Bearer token from sessionStorage['manus-cookie'] which is PREVIEW-ONLY; on real phone at prod domain there is NO Bearer, so it relies solely on the SameSite=None cookie
- [x] Cookie is HttpOnly SameSite=None Secure; OAuth callback sets it but NEVER exposes token to client JS -> no localStorage fallback when mobile drops the cookie on XHR
- [x] OAuth callback now redirects to /#session=<token> (fragment never hits server/logs) in addition to setting the cookie
- [x] Client lib/sessionToken.ts: captures fragment token on boot, persists to localStorage['lds-session'], strips URL
- [x] tRPC client attaches Authorization: Bearer from localStorage on EVERY request (preview sessionStorage kept as secondary fallback)
- [x] Logout clears localStorage['lds-session']
- [x] Tests: server oauth.fragment.test.ts + client sessionToken.test.ts (6 new) — 70/70 pass, 0 TS errors
- [ ] User publishes; sign OUT then back IN on phone (to mint the fragment token), then verify picks load
