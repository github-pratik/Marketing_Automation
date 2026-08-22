# OryonIQ — Personal-Reach Engine

The "brain" of the OryonIQ outbound system. It finds the right GovCon people, keeps only the
reachable ones, and writes a genuinely personal opener for each from a **live market signal** —
then hands off a ready-to-send list. One engine; swap the config file and it runs for any
Visioneerit product.

---

## ▶ Run the guided demo (30 seconds, no setup)

No API keys, no accounts, no installs — just Python 3. It replays a **real run** and explains
each step as it goes.

```bash
python3 demo.py
```

Press **Enter** to move through the four stages. That's it.

> Don't have Python? On a Mac, run `python3 --version`. If it's missing, macOS will offer to
> install the developer tools — accept, then re-run.

**What you'll watch:**

| Stage | What happens | Cost |
|-------|--------------|------|
| 1 · Source | Ask Apollo who matches the target (title, location, "government contracting") | **$0 — search is free** |
| 2 · Filter | Drop anyone with no reachable email, before spending anything | **$0** |
| 3 · Personalize | OpenAI writes a specific opener for each person from the live signal | fractions of a cent |
| 4 · Output | Assemble the finished emails → `leads.csv`, ready for sending | — |

The whole point: **search wide for free, only ever pay to reveal contact data on the few worth
keeping.** That's how it uses Apollo without burning credits.

---

## ▶ Run it live on fresh leads (optional)

The demo is canned so anyone can watch it. To run the engine for real:

1. Copy the key template and add your own keys:
   ```bash
   cp .secrets.env.example .secrets.env
   # then edit .secrets.env — add your Apollo + OpenAI keys
   ```
2. Run:
   ```bash
   python3 engine.py config-oryoniq.json --limit 10                    # free: source + personalize
   python3 engine.py config-oryoniq.json --limit 10 --reveal --verify  # spend credits on survivors
   ```

`--reveal` (and `--verify`) only ever touch the already-filtered survivors — never the whole list.
`--verify` requires `--reveal` (or `--seed-email`) first — there's nothing to verify without a
real email.

### Seeded test — check output quality against your own inbox, not a stranger's

```bash
python3 engine.py config-oryoniq.json --seed-email you@yourdomain.com --verify
```

Skips Apollo entirely (zero credits — no search, no reveal) and runs one synthetic lead straight
through verify → personalize → assemble, so you can read the actual generated email before it
ever reaches a real prospect. Writes to `seed-test.json`/`seed-test.csv`, never touches
`leads.csv`. Add `--seed-name` / `--seed-title` / `--seed-company` to change the persona used for
personalization (defaults are generic placeholders).

---

## The files

| File | What it is |
|------|-----------|
| `demo.py` | the guided, no-setup walkthrough (run this first) |
| `engine.py` | the actual engine |
| `config-oryoniq.json` | the **product config** — ICP, signal, offer, sender. The agent writes these. |
| `config-visioneerit.json` | a second product — same engine, one file swapped |
| `config-template.json` | a blank, self-documenting template — copy it to start a new product |
| `.secrets.env.example` | template for your API keys (live mode only) |
| `leads.csv` / `leads.json` | the output, produced by a run. **The committed copies predate 2026-08-17** and still show OryonIQ's old `visioneerit.com/contact` CTA — they are an honest record of the run that made them, not a fixture, so they are left alone and will be correct on the next run. Same for `seed-test.csv`/`.json`. |
| `push_to_instantly.py` | enrol leads into the Instantly email campaign (enrol only — cannot send) |
| `push_to_sendr_page.py` | generate a personalized Sendr page per lead, per product config |
| `make_scroll_gif.py` | build + host the per-lead scroll GIF for the outreach message |
| `test_sigv4.py` | verifies the hand-rolled S3 signing against AWS's published vectors |

## The outreach assets, in order

```bash
python3 engine.py --config config-oryoniq.json --reveal --verify   # -> leads.json
python3 push_to_sendr_page.py leads.json --config config-oryoniq.json
python3 make_scroll_gif.py leads.json                              # after ~1 min
python3 push_to_instantly.py leads.json
```

Each step writes what the next one needs back into `leads.json` (`sendr_page_id`,
`sendr_page_url`, `gif_url`), so the chain is resumable — rerun any step alone.

### Why we build the GIF ourselves

Sendr's own GIF task is broken on this account: `pageGifTask: missing recordingFileUrl` on every
`gifSource`, including `landing-page`, which by Sendr's docs shouldn't need a recording at all. The
**page itself is fine** — it renders and is safe to send; only the GIF asset fails.

`make_scroll_gif.py` rebuilds that one asset with no new capture infrastructure, because Sendr
already screenshots the lead's own website per page (a ~1440×9000 full-page capture) and hosts it.
The GIF is a pan down that image — an ffmpeg filter, not a video composition, so no video framework
is involved. ~390KB at the defaults, which every major mail client loads inline.

Hosting is any S3-compatible bucket (Cloudflare R2 or DigitalOcean Spaces — same API), configured
via the `ASSET_S3_*` keys in `.secrets.env`. Without them the GIF still builds locally; it just
isn't uploaded. The bucket must be public-read, since a prospect's mail client loads the URL
directly. Object keys use the Sendr page **slug**, never the lead's name or email — that URL is
public and must not leak who was contacted.

## The config is the contract (the important part)

In production, the engine **logic runs on n8n** and travels with an **AI agent**. This Python is
the reference implementation and an offline backup. The one thing that changes per product or
campaign is the **config file**, and the agent generates it. So the config is the contract:

- **Get it right → the engine runs anything.** Swap `config-oryoniq.json` for
  `config-visioneerit.json` (or any product) and the same engine sources and personalizes for that
  product. No code change.
- **Get it wrong → nothing runs.** Every run validates the config first and refuses to launch on a
  bad one, so a malformed config never reaches a real prospect.

A valid config needs: `product`, `one_liner`, `signal`, `offer`, `cta`, `sender`, a
`personalization_prompt` containing `{first_name}` and `{company}`, and an `icp` with non-empty
`person_titles` and `person_locations`.

## How it fits the bigger picture

This is the **front half** — the research + personalization moat, and the part that's cheap and
runs today. The **sending half** plugs into `leads.csv`: **Instantly** sends the email, **Sendr**
adds the LinkedIn touch + a personalized page, and a positive reply hands off to a human — all
orchestrated by **n8n**. Same engine feeds all of it.

**There is no automated call leg.** Thoughtly (warm voice) was skipped 2026-08-17 at the user's
direction; no dial node exists in any workflow and none ever did. A positive reply is classified by
OpenAI, passed through the dedup/TCPA gate, and posted to Slack as Approve/Decline — where Approve
means *a human takes the follow-up*. See `../CLAUDE.md` → "Voice is skipped".
