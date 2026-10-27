# Video module blueprint: AniKoto 5 reference

Owner direction, 2026-09-10: use this checklist for future video-module work.
Reference: AniKoto 5.0.0, approved beta.14 extraction code, Bundle 105.
This is a reusable behavioral standard, not an instruction to copy AniKoto's
site-specific endpoints, provider names, timeouts or defects into every module.
Existing MODULE_CONTRACT.md and app parsers remain authoritative for field types.

## Required playback baseline

- Search, details and episodes identify the correct title, season and episode.
  Reject ambiguous matches; never silently substitute the first search result
  or episode one. Preserve stable IDs and legacy episode references.
- Dub means verified target-language speech (English for our English Dub modules).
  Sub means original-language speech with usable English subtitles. Original
  language may be Japanese, Chinese or another language: do not hardcode Japanese.
- Missing Dub is not a failure when the source does not offer it. Report absence
  honestly; do not advertise it unconditionally or substitute Sub for Dub.
- Normal streaming, seeking, pause/resume, downloading and completed offline
  playback are separate checks. Successful resolution/download is not playback.
- Preserve URL and required headers together. Reject HTML/image placeholders;
  check actual media and do not infer playback from HTTP 200 or metadata alone.
- Keep app code, accounts, entitlements and backend unchanged for module repairs
  unless the owner separately authorizes that scope.

## Source capabilities

Required implementation support does not mean every episode has every feature.
For each source, record: supported and returned / source does not supply /
module drops or misparses / unverified. Never invent options to fill the UI.

### Servers and recovery

- Preserve distinct checked alternatives in the existing `servers` contract;
  automatic provider fallback alone is not a user-selectable server picker.
- Retain a valid primary `url`, `headers`, `lang` and `streamType` for older apps.
  Server entries carry their own URL, headers, language, subtitles and markers.
- Deduplicate equivalent transports, considering URL plus relevant headers and
  track context. Three names pointing to the same transport are not three backups.
- Resolve within the app's time/concurrency budgets. Never launch an unbounded
  provider scan or wait indefinitely for backups after playback is available.
  Do not apply AniKoto's three-route fallback cap as a universal server limit.
- Timed-out work must not mutate returned selections or start new requests.
  Honor provider rate limits; retry storms or bypassing access controls are not
  reliability strategies. Do not claim a Promise timeout cancels HTTP requests.

### Quality choices

- Parse the actual HLS master ladder or independently supplied MP4 qualities.
- Validate each exposed option, preserve its headers and report accurate labels
  and numeric heights. Never label every embed 1080p by assumption.
- Populate the existing `streams` and `qualities` representations used by the
  playback/download consumers, with a valid default URL and matching selection.
- A single rendition is acceptable if that is what the source genuinely offers.
  A master hidden behind one selected rendition is an implementation gap.
- Preserve per-server quality/track context supported by the existing contract;
  do not mix URLs from one server with another server's headers or captions.

### Subtitles, audio and markers

- Preserve all usable source-provided subtitle languages for both Sub and Dub.
  Parse supported provider metadata, player configuration and legitimate embed
  parameters; opaque tokens must not be treated as direct subtitle URLs.
- Preserve full-dialogue, signs/songs and generated-caption labels. Deduplicate
  identical tracks without losing distinct translations or language variants.
- Sub requires usable English captions: soft tracks or evidenced hardcoded
  captions. Dub captions and additional languages are bonuses, not mandatory
  when absent upstream. Signs-only is not proof of full dialogue for Sub.
- Do not fabricate an audio-track picker for a file with a single embedded track.
- Forward real intro/outro ranges through the existing marker fields. Validate
  finite nonnegative start/end and end > start; zero is a valid start.
  Missing timing must remain absent. Use only already-supported, authorized
  service fallback; no new service dependency or arbitrary skip range.
- Forward trustworthy filler/mixed metadata where available and safely mapped
  to exact episode identity. Unknown must remain unknown, not canon by default.

## Compatibility and architecture

- Preserve module ID, family ID, identity number and existing handler signatures.
- Add optional metadata while retaining legacy primary stream and subtitle fields.
  Do not require a new app API, schema or module interpreter for these upgrades.
- Test current Player and an actual supported older runtime. Unknown-field
  tolerance alone does not establish compatibility; check real imports and playback.
- Keep provider-specific adapters separate conceptually from common normalization,
  identity checks and validation. A shared implementation is optional and must be
  bundled locally if used; no remote executable dependency added for convenience.
- Saved-copy localhost retries, app lifecycle failures and unavailable controls
  during offline playback are app issues, not grounds for rewriting a module.

## Test and release checklist

1. Freeze the exact candidate ZIP/version/hash. Inspect manifest and exports.
2. Regression fixtures: incorrect/ambiguous identity, missing Dub, captions/tokens,
   duplicate servers, valid/broken qualities, marker bounds, slow/late responses.
3. Use a recorded 30-title matrix: 20 repeatable regression titles and 10 randomly
   selected at test time with seed and selection method saved. Cover long series,
   multiple seasons, movies, older/new titles and provider failures. Test both
   advertised Sub and Dub; include first/middle/latest episodes across the sample.
4. Minimum pass = right content, right audio, usable Sub captions and actual
   playback. Score extra captions/languages, distinct servers, qualities, markers
   and filler separately as bonuses. Do not fail a source for nonexistent extras.
5. Record unavailable, failed, unverified and passed separately. Preserve first
   failures and retry outcomes; never turn intermittent failure into a clean pass.
6. Run real Flutter runtime plus S2 native playback/seek/pause checks. Test
   downloading each exposed quality separately and play completed files offline.
7. Owner tests the private candidate. No production publication without explicit
   approval. Report incomplete checks even when the owner accepts the release risk.
8. Publish immutable ZIP, signed index and updated bootstrap entry as appropriate.
   Verify public version/hash and leave previous artifacts available for rollback.

## Reference limitations: do not copy them

AniKoto 5.0.0 was owner-approved with simulator certification incomplete and
intermittent resolution/caption gaps disclosed. Its quality ladder improvement
applies to the primary extractor; its separate Otaku fallback still returns Auto
quality rather than a full ladder. Some native server labels resolve to the same
URL. Filler support is not universal. These are known gaps, not the desired
standard. Approval of AniKoto is not certification of another module.

Current next assessment: ANIKAGE_BLUEPRINT_AUDIT_2026-09-10.md.
