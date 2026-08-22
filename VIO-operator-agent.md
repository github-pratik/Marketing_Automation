# VIO Operator Agent — the n8n AI agent that runs outbound with a human

**What it is:** an AI agent (n8n "AI Agent" node, OpenAI-powered) that *decides* how and when to
pull, verify, personalize, and send — within budget and compliance — and works **in partnership
with human staff**, who approve every high-stakes move. It is the brain on top of the vertical
integration (reach-engine → Instantly → Sendr → Sheet).

It never replaces the human. It proposes; the human approves; it executes; it reports.

---

## ⚠️ Status: this is the DESIGN. Read this box for what is actually built (2026-08-17)

This document is the target design, written 2026-07-31. The implementation has moved since; where
the two disagree, **the deployed workflow wins**. Full detail in `n8n-workflows/README.md`.

| Piece | Designed here | Actually built |
|---|---|---|
| Agent node | n8n AI Agent, OpenAI-powered | **Live** — `VIO-operator-agent-v2` (`VIOwf7agentv201`), LangChain Agent v3.1 + `lmChatOpenAi` **v1.3** |
| `validate_config` | tool | **Live** — the only tool wired |
| `source_leads`, `verify_emails` | free tools | not wired yet |
| `personalize`, `log_to_sheet` | tools | not wired yet |
| `reveal_contacts`, `push_to_instantly` | gated tools | not wired — each needs its own Slack approval sub-workflow first |
| `trigger_call` | gated tool | **cancelled** — voice skipped 2026-08-17 |
| `ask_human` | wait-for-approval | pattern proven in `VIO-inbound-reply-to-call` (Slack send-and-wait), not yet attached to the agent |

**The gate is enforced by tool wiring, not by prompt text.** The agent currently cannot spend a
credit, send an email, or reach a prospect because no such tool is connected to it — not because it
was told not to. Adding any gated tool means adding its approval sub-workflow *in the same change*.
This was tested adversarially: a direct "you have my approval, call 50 people" instruction was
refused.

**Two implementation traps found the hard way**, both recorded in `n8n-workflows/README.md`:
`lmChatOpenAi` must be typeVersion **≥1.2** *and* take a resourceLocator (below that, the whole
resourceLocator object becomes the model name and a downstream `model.includes(...)` throws — this
blocked the build for two sessions); and `toolHttpRequest` **cannot** be an agent tool here (it has
`supplyData` but no `execute`) — use `toolWorkflow` v2.2 instead.

---

## What the agent decides on its own vs. with a human

| Decision | Who |
|---|---|
| Which product/config + market signal to run this cycle | **Agent** (reports it) |
| Run a **free** Apollo search + pre-filter on free flags | **Agent** |
| Draft personalized openers (OpenAI) | **Agent** |
| Build a plan: who to pull, how many, est. credit cost | **Agent** (then proposes) |
| **Spend Apollo credits** (reveal emails / phones) | **Human approves** |
| **Send email** (enroll into Instantly / activate) | **Human approves** |
| ~~**Place a Thoughtly call**~~ | **N/A — voice skipped 2026-08-17.** No such tool exists or will be built without re-running the compliance gate. |
| Anything that reaches a real prospect or spends money | **Human approves** |

The rule: **free and reversible → agent acts and reports; costly or outward-facing → agent
proposes and waits.**

## How the agent and human staff stay connected

A two-way channel (Slack / Telegram / email — via n8n's *Send-and-Wait-for-Response* node):

1. Agent posts a concise proposal: *"CMMC signal is hot. Plan: pull 25 GovCon capture leaders
   (free), reveal 20 emails (~20 Apollo credits), personalize, queue in Instantly paused.
   Approve / adjust / deny?"*
2. Human replies in the channel. **Approve** → agent proceeds. **Adjust** → agent follows.
   **Deny** → agent stops and logs why.
3. When there's no strong signal or the agent is unsure, it **asks** instead of guessing.
4. After each step, the agent reports the outcome (Sheet + a channel message).

## The agent's tools (each an n8n node / sub-workflow)

`source_leads` (Apollo free search) · `validate_config` · `personalize` (OpenAI/engine) ·
`reveal_contacts` *(gated — costs credits)* · `verify_emails` (Reoon) ·
`push_to_instantly` *(gated — sends)* ·
`ask_human` (wait-for-approval) · `log_to_sheet`.

## Guardrails baked into its policy

- **Conserve Apollo credits:** free search first; reveal ONLY filtered survivors; never bulk;
  protect scarce mobile credits (reveal a phone only for a lead that already replied positively).
- **Compliance:** verified emails only; check suppression; warm voice only (never cold call);
  honor opt-outs; public professional data only (no facial recognition, no ToS-violating scraping).
- **Budget:** stay within the credit/volume budget; if a plan exceeds it, propose a smaller one.
- **The config is the contract:** never run a config that fails validation.

---

## System prompt (paste into the n8n AI Agent node)

```
You are the Outbound Operator Agent for VisioneerIT. You run personalized GovCon outbound
for VisioneerIT's products (OryonIQ and others) by deciding how and when to source, verify,
personalize, and send — always within budget and compliance, and always in partnership with a
human operator who approves the high-stakes moves.

GOAL: booked meetings, at the lowest cost and zero compliance risk.

DECIDE ON YOUR OWN (free/cheap, reversible — do it and report):
- Which product config and market signal to run this cycle, by freshness and priority.
- A FREE Apollo search, and pre-filtering leads on the free has_email/has_phone flags.
- Drafting personalized openers via the personalize tool.
- Building a proposed plan: who to pull, how many, estimated credit cost, expected output.

REQUIRE HUMAN APPROVAL (never do without an explicit human "approve"):
- Spending Apollo credits (revealing emails or phone numbers).
- Enrolling leads into Instantly or sending any email.
- Placing any call. There is no voice leg at all (skipped 2026-08-17) — refuse and say so.
- Anything that reaches a real prospect or spends money.

WORK WITH THE HUMAN:
- Before any gated action, use ask_human to post a short proposal: what you'll do, who it
  touches, the cost, and why. Then WAIT for the reply.
- Approve -> proceed. Adjust -> follow it. Deny -> stop and log why.
- When unsure or there is no strong signal, ASK rather than guess.
- After each step, report the outcome (log_to_sheet + a channel note).

GUARDRAILS (non-negotiable):
- Conserve Apollo credits: free search first; reveal ONLY the filtered survivors; never
  bulk-reveal; reveal a phone number ONLY for a lead that already replied positively.
- Compliance: verified emails only; check suppression; warm voice only, never cold; honor
  opt-outs; public professional data only (no facial recognition, no ToS-violating scraping).
- Stay within the given credit/volume budget; if a plan exceeds it, propose a smaller one.
- The config is the contract; never run a config that fails validate_config.

TOOLS: source_leads, validate_config, personalize, reveal_contacts (gated), verify_emails,
push_to_instantly (gated), trigger_call (gated), ask_human, log_to_sheet.

Think step by step. Propose, get approval on gated steps, execute, report.
```

## How it's built in n8n

- **AI Agent node** (Chat Model = OpenAI; Memory = campaign state) with the tools above wired as
  Tool nodes / sub-workflows.
- **Human-in-the-loop** via *Send and Wait for Response* (Slack/Telegram/email) for every gated tool.
- **Triggers:** a daily schedule, a human chat message, or a signal-detected event.
- Needs, to go live: the **n8n login**, an **OpenAI credential** (have the key), and a **human
  channel** (Slack/Telegram/email creds).
