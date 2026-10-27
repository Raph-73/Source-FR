# Module test report template

Module ID/name/version:
ZIP SHA-256:
App version/device/OS:
Source permission and source URL (no tokens):
Test date/time and network type:

## Coverage

| Exact title/year | Season/episode or chapter | Audio | Route/quality | Result | Evidence layer | Failure reason |
| --- | --- | --- | --- | --- | --- | --- |
| Fill in | Fill in | Fill in | Fill in | PASS/FAIL/BLOCKED | Local/S2/device | Fill in |

Suggested release sampling: 20 fixed cases plus 10 seeded or recorded random cases.
Include new/old titles, first/middle/latest episodes, long lists, absent dub, movies,
non-Latin titles and empty results. Use fewer cases only with a documented reason
(for example a source with five titles). Pace requests; stop on throttling.

Record attempted/pass/fail/blocked counts separately. A resolution pass is not a
playback pass. Test SUB and DUB independently when available. Never call every
failure a network problem without evidence.

## Functional checks

- Home: real posters, featured section if supported, next feed page, no duplicates.
- Search/detail: exact identity, same-name remakes, empty search and missing title.
- Lists: compare counts with source, all seasons/movies, stable IDs, episode order.
- Video: advancing picture and audible speech, correct language and episode.
- Subtitles: each exposed language, correct episode, timings and actual rendering.
- Controls: pause/resume, seek, quality/server change and foreground/background.
- Download: completion, airplane-mode playback, audio and subtitles separately.
- Manga: ordered pages, first/middle/last, volume boundaries and headers.
- Errors: useful message, bounded time, no substituted content, no leaked URLs/keys.

## Final verdict

Local checks: PASS / FAIL / NOT RUN
S2 (video, maintainer tools): PASS / PARTIAL / FAIL / BLOCKED / NOT RUN
Physical-device playback or reader test: PASS / FAIL / NOT RUN
Download/offline: PASS / FAIL / NOT RUN
Known limitations:
Release approved by:
