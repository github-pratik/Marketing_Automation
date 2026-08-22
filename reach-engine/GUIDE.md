# OryonIQ Reach Engine — Guide

One engine (`engine.py`), many products (swap the config). The demo (`demo.py`) walks the same pipeline with no API keys.

---

## 1. Config — `config-oryoniq.json`

Everything product-specific lives here. The engine reads this file and does not hardcode OryonIQ copy.

| Field | Purpose |
|-------|---------|
| `product` | Product name shown in the run banner |
| `one_liner` | Short pitch printed at the start of a live run |
| `icp.person_titles` | Apollo title filters (e.g. Capture Manager, VP BD) |
| `icp.person_locations` | Geo filter (OryonIQ: `United States`) |
| `icp.q_keywords` | Free-text Apollo keyword (OryonIQ: `government contracting`) |
| `signal` | Live market hook fed into the OpenAI system prompt |
| `offer` | Mid-email value line after the opener |
| `cta` | Link used in the soft ask |
| `sender` | Sign-off block (name + company) |
| `personalization_prompt` | Template for the per-lead opener. Placeholders: `{first_name}`, `{title}`, `{company}` |

**To target another Visioneerit product:** copy this file, change ICP / signal / offer / CTA / sender / prompt, then point `engine.py` at the new path.

---

## 2. Engine — `engine.py`

Pipeline: **source → filter → personalize → assemble → write files**.

| Step | What it does | Credits |
|------|----------------|---------|
| 1. Source | `POST` Apollo `mixed_people/api_search` using `icp` | Free |
| 2. Filter | Keep people with `has_email`, truncate to `--limit` | Free |
| 3. Personalize | OpenAI (`gpt-4.1-mini` by default) writes one opener per lead from `signal` + `personalization_prompt` | Cheap tokens |
| 4. Assemble | `Hi {name}` + opener + `offer` + CTA ask + `sender` | — |
| 5. Output | Writes `leads.json` and `leads.csv` next to the script | — |

**CLI:**

```bash
python3 engine.py config-oryoniq.json --limit 5
python3 engine.py config-oryoniq.json --limit 25 --model gpt-4.1-mini
```

| Flag | Default | Meaning |
|------|---------|---------|
| `config` | (required) | Path to product JSON |
| `--limit` | `5` | Max emailable leads to keep |
| `--model` | `gpt-4.1-mini` | OpenAI chat model |
| `--reveal` | off | Intended: Apollo `people/match` on survivors only (costs lead credits) |
| `--verify` | off | Intended: Reoon verify on revealed emails |

Secrets: loads `.secrets.env` from this folder, or one level up. Required keys for a live run: `APOLLO_API_KEY`, `Openai_api_key`. Optional for verify: `REOON_API_KEY`.

---

## 3. Run the guided demo — `demo.py`

No keys, no installs beyond Python 3. Replays a real past run so you can see each stage.

### Steps

1. Open a terminal and go to this folder:

   ```bash
   cd "/Users/shashikant/Desktop/Visioneerit/OryonIQ/reach-engine 2"
   ```

2. Confirm Python 3:

   ```bash
   python3 --version
   ```

   If missing on macOS, accept the Xcode CLT prompt, then retry.

3. Start the demo:

   ```bash
   python3 demo.py
   ```

4. Press **Enter** at each pause to advance through:

   | Step | You see |
   |------|---------|
   | Banner | What the engine is and that config drives the product |
   | Source | Sample Apollo matches + emailable flags |
   | Filter | Who is kept vs dropped (`has_email`) |
   | Personalize | The live signal + real openers for Kiara / Nina / James |
   | Assemble | Full example email for Kiara |
   | Outro | How this feeds Instantly / Sendr via n8n (voice skipped 2026-08-17 — a positive reply goes to a human, not a robot call) |

5. Done. Non-interactive shells (piped stdin) skip pauses and print the full walkthrough in one go.

---

## 4. Optional — run live (fresh leads)

1. Copy the secrets template:

   ```bash
   cp .secrets.env.example .secrets.env
   ```

2. Put real Apollo + OpenAI keys in `.secrets.env` (never commit that file).

3. Run:

   ```bash
   python3 engine.py config-oryoniq.json --limit 10
   ```

4. Open output: `leads.json` / `leads.csv` in this same folder.

If secrets are missing, the engine exits and points you back to `python3 demo.py`.
