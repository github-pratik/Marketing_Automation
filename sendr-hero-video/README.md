# Sendr hero videos — OryonIQ & VisioneerIT

Two 15-second branded hero videos, one per product, built to be **uploaded into the Sendr page
templates**. Plus email-ready GIFs cut from the same source.

Built with HyperFrames (HTML → MP4). Everything here is source; nothing is a stock asset.

## What to do with these

| File | Where it goes | Why |
|---|---|---|
| `deliverables/oryoniq-sendr-hero-1080p.mp4` | Sendr page template **8462**, as the template video | Fixes `pageGifTask: missing recordingFileUrl` and gives the hero slot real content |
| `deliverables/visioneerit-sendr-hero-1080p.mp4` | Sendr page template **8464** | same |
| `deliverables/*-email.gif` | the Instantly email / Sendr LinkedIn message | 448KB, 520px, loads inline in every major mail client |
| `deliverables/*-poster.jpg` | anywhere a still is wanted | first-frame fallback |

**Uploading is a manual step and cannot be automated.** Sendr has no create/update endpoint for
page templates — the API is read-only on templates (`GET /page-template/list`,
`GET /page-template/{id}/variables`). Upload in the Sendr UI, then confirm it actually saved:

```bash
# SENDR_API_KEY must already be in your shell (from local .secrets.env). Do not paste the key here.
cd .. && curl -s -H "X-API-Key: $SENDR_API_KEY" https://api.sendr.io/api/v1/page-template/list | python3 -c "import sys,json,datetime;n=datetime.datetime.now(datetime.timezone.utc);[print(f\"{t['id']} edited {int((n-datetime.datetime.fromisoformat(t['updatedAt'].replace('Z','+00:00'))).total_seconds()/60)} min ago, mediaType={t['mediaType']}\") for t in json.load(sys.stdin) if t['id'] in (8462,8464)]"
```

`edited 0-2 min ago` and a non-null `mediaType` means it saved. If it still reads hundreds of
minutes, the save did not reach Sendr — that has happened before on this account, and no amount of
re-rendering fixes it.

## Editing them

```bash
export PATH="/opt/homebrew/bin:$PATH"   # HyperFrames needs Node 20+; the system node is 18
cd oryoniq
npx hyperframes@0.7.109 check --at 1.9,2.9,5.6,6.8,9.6,10.9,12.9,13.9
npx hyperframes@0.7.109 render
```

**Sample at settled frames, not the default even spacing.** The default lands inside the 0.4s scene
pushes, where every element is legitimately mid-fade, and reports transient contrast failures that
are not real.

## Design decisions worth keeping

- **Palette is not invented.** Every hex is lifted from `../visioneerit-outbound-docs.html`, the
  brand doc already published for Gavriel — navy `#090b19`, surface `#101a33`, accent `#f26e18`.
  The video and the doc read as one system because they share a source.
- **Archivo 900/300 + IBM Plex Mono.** The register is institutional authority plus technical
  precision — a federal solicitation cover sheet, not a startup deck. Plex Mono is the data voice
  precisely because it comes from enterprise/government design, so the solicitation numbers read as
  a system readout rather than decoration. Archivo is **not** in the renderer's auto-resolved font
  list, so `fonts/*.woff2` and the `@font-face` blocks are load-bearing — remove them and the video
  silently falls back to a system sans.
- **No ghost type.** Oversized faded words are the obvious background-layer choice, but the WCAG
  pass samples them as text and there is no opt-out, so they fail the build. Registration brackets
  (pure CSS borders) carry the same technical-document weight and aren't text.
- **No `letterSpacing` tweens.** They reflow text and snap glyph positions under the frame-seek
  capture engine. Transform equivalents only.
- **Scene 3 differs by product on purpose.** OryonIQ names three real-format solicitations
  (verifiable, which is the whole pitch). VisioneerIT names capability + delivery window instead —
  inventing security findings about a named prospect would be the one claim on the page that could
  be checked and found false.

## These are TEMPLATE videos

The same video plays for every lead. Per-lead personalization comes from the Sendr page variables
(`firstname`, `company`, `opener`), not from the video — so nothing here should ever name a
prospect.
