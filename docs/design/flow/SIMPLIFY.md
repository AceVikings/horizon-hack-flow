# Flow v1 — simplification brief

The v1 frames are correct in content but too dense. Flow must feel calm and user-driven: show one
clear thing, let the user ask for more. This brief overrides layout density in the v1 frames.

## Principles

1. **One screen, one job, one main number.** Everything else is behind "Show details".
2. **User-driven.** The user picks what to do; Flow does not push dashboards at them.
3. **Plain words by default.** No bps, pair indices, nonces, hashes or contract names on default views.
   They appear in "Details", in Pro mode, or when the user asks the agent.
4. **The agent is the front door.** Anything not on screen can be asked for in Chat
   (charts, data, explanations, actions).
5. **Proof on demand.** Safety facts are one tap away, never a wall of links.

## Navigation (4 items + menu)

| Item | What it is |
|---|---|
| **Home** | Status in one sentence + the four start actions |
| **Ask** | Chat with the agent (charts and data appear here when asked) |
| **Trade** | Markets, charts and the manual order panel (collapsed) |
| **Activity** | Decisions, trades and positions in one plain timeline |
| ⋯ menu | Safety & proof, Tools & guides, Accounts, Settings, Payments (greyed) |

Remove the always-on right inspector and the dense evidence footer. Keep a slim status bar:
network · vaults OK/paused · agent running/stopped · "Details" link.

## Home

- One sentence: "Your agent is trading. Today: +$0.31. It can lose at most $51.50 today."
- One large control: **Pause** / **Resume**.
- Four start actions as large cards: **Let the agent trade** · **Ask the agent** ·
  **Trade it myself** · **Check safety**.
- "Show details" expands budgets per vault, the worst-case meter and the last three decisions.

## Setup

Three visible steps: **Connect** (network + vaults, owner device QR) → **Set limits** (plain
sliders with the worst case shown in dollars) → **Start** (AI account + funding check).
Health checks run silently; only failures are shown, with one fix button each.

## Modes

- **Simple (default):** the views above.
- **Pro:** toggle in ⋯ → shows the current dense v1 panels (prices side by side, candidates,
  limits tables, footer with addresses). Remember the choice per user.

## Copy rules

- Sentences under 15 words on default views. Verbs first on buttons ("Pause trading").
- Money in dollars first; token amounts second and smaller.
- Numbers explained in place ("most it can lose today"), not as jargon labels.

## Visual rules

- More white space: one column on default views, max width ~880 px, generous padding.
- Anton only for the page title and the one main number; everything else in the body font.
- Yellow only for the primary action and the one highlight per screen.
- No one-sided accent stripes, ever.
