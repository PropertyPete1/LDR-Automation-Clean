# Agent Registry Data (gathered from bot files)

## Existing 6 Agents (to be migrated as engine_active=false)

| Agent | FUB ID | Email | Bot Name | Bot Slug | First Name | Last Name |
|-------|--------|-------|----------|----------|------------|-----------|
| Steven Van Orden | 1 | Steven@lifestyledesignrealty.com | S&P500 Lifestyle Bot (Steven) | sp500_steven | Steven | Van Orden |
| Peter Allen | 2 | peter@lifestyledesignrealty.com | S&P500 Lifestyle Bot (Peter) | sp500_peter | Peter | Allen |
| Tiffany Proske | 20 | Tiffany@lifestyledesignrealty.com | Tiffany's Lifestyle Bot | tiffany | Tiffany | Proske |
| Stefanie/Rue | 31 | Stefanie@lifestyledesignrealty.com | Rue Lifestyle Bot | stefanie | Rue | (empty) |
| Abby | 28 | Abby@lifestyledesignrealty.com | Abby's Lifestyle Bot | abby | Abby | (unknown) |
| Irma | 33 | Irma@lifestyledesignrealty.com | Irma's Lifestyle Bot | irma | Irma | (unknown) |
| Laila | 35 | Laila@lifestyledesignrealty.com | Laila's Lifestyle Bot | laila | Laila | (unknown) |

## Notes
- SP Bot is special: runs for BOTH Steven (FUB 1) and Peter (FUB 2) in one file
- Stefanie's bot uses "Rue" as the display name but email stays Stefanie@
- All bots use peter@ SMTP with BCC peter@
- All bots CC peter@ and steven@ on clock-in/clock-off emails
- LEADER_AGENTS set: peter, steven, stefanie, rue (get extra Power Queue info in clock-in)

## Jason Lookup — CONFIRMED
- ID: 37
- Name: Jason Casanova
- Email: Jason@lifestyledesignrealty.com
- Role: Agent
- Status: Active

## Full FUB User List (for reference)
| ID | Name | Email | Role | Status |
|----|------|-------|------|--------|
| 37 | Jason Casanova | Jason@lifestyledesignrealty.com | Agent | Active |
| 35 | Laila Maria | laila@lifestyledesignrealty.com | Agent | Active |
| 33 | Irma Vidic Crisp | Irma@lifestyledesignrealty.com | Broker | Active |
| 31 | Stefanie Graham | stefanie@lifestyledesignrealty.com | Broker | Active |
| 28 | Abby Martinez | abby@lifestyledesignrealty.com | Agent | Active |
| 20 | Tiffany Proske | Tiffany@lifestyledesignrealty.com | Agent | Active |
| 16 | Luke Durbin | Luke@lifestyledesignrealty.com | Agent | Active |
| 2 | Peter Allen | peter@lifestyledesignrealty.com | Broker | Active |
| 1 | Steven Van Orden | steven@lifestyledesignrealty.com | Broker | Active |

## Staged Cutover Plan
1. Build agent_bots table, engine, admin UI, intro flow
2. Migrate 6 existing bots as engine_active=false
3. Add Jason as engine_active=true (after user confirms FUB lookup)
4. Tomorrow 10am: old files run for 6 agents, new engine runs ONLY for Jason
5. Engine must skip the 6 flagged bots, old files must not know about Jason
6. After run: equivalence proof (simulate engine output for 6 vs actual)
7. Cutover: flip 6 to engine only after Peter verifies diff is clean
