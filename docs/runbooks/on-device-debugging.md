# On-device debugging

How to inspect the app on the Android phone in the field: remote DevTools,
the built-in instrument routes, getting fixtures off the device, and looking
at (or repairing) the OPFS data files.

## Remote DevTools (chrome://inspect)

1. On the phone: Settings → Developer options → USB debugging on.
2. Connect USB; on the desktop open `chrome://inspect#devices` in Chrome.
3. Authorize the phone, find the chronowhoop.com tab (or the installed PWA —
   it lists as a Chrome tab), hit **inspect**: full DevTools against the
   device, console, network, and the OPFS snippets below included.
4. `chrome://inspect` also works for the service worker ("Service workers"
   section) when debugging update/offline behavior.

No USB? The app's own error surfacing is designed to be enough for most
field issues (capture errors, storage errors, quarantine notices all render
in the UI) — screenshot them.

## `/diag` — capability and probe panels

Permanent route, works offline. Capabilities verdict at the top (what the
support gate saw), then panels: Camera (permission + granted constraints),
Frame loop (delivered fps, timestamp-source stats), GPU device / Texture
import / Readback benchmark (retired WebGPU spike instruments, kept for
reference), CPU pipeline and **CPU pipeline (WebCodecs)** (the live pipeline's
per-frame cost + processed rate), Speech (utterance event probes), Storage
(OPFS) (persistence, quota, atomic-write probes), Wake lock. "Re-run probes"
re-executes without a reload.

## `/lab` — pipeline instruments

Live pipeline panel (camera → ROI → strip energies at full rate), Tunables,
Test mode (beep per detected crossing, records nothing), **Recorder** (fixture
capture: continuous ~30 s recording or a ring-buffer snapshot, downloaded as a
raw-luma `.cwclip`), Annotation stepper (frame-step a clip, mark ground-truth
crossings → sidecar JSON), **Self-test** (replays the bundled fixture clip
through the deployed bundle's pipeline and compares bit-exact against the
committed energy JSON — run this first when detection "seems off" on a
device).

Field fixture capture: reproduce the scene in `/lab` with the product's
tunables (the panels share them), Record / Snapshot ring, then get the
`.cwclip` off the device via the share sheet or Files app. See
`field-acceptance.md` for the annotation/tiering workflow.

## OPFS inspection

Layout (see `docs/specs/storage.md`): `courses.json` at the root,
`sessions/<uuid>.json` per session. DevTools has no native OPFS browser;
either install the "OPFS Explorer" DevTools extension, or use console
snippets via remote inspect:

```js
// List everything
const root = await navigator.storage.getDirectory()
for await (const [name, handle] of root) console.log(handle.kind, name)
const sessions = await root.getDirectoryHandle('sessions')
for await (const [name] of sessions) console.log(name)

// Read a file
const fh = await sessions.getFileHandle('<uuid>.json')
console.log(await (await fh.getFile()).text())

// Download a file out of the page (runs in the page context)
const blob = await (await fh.getFile()).slice()
const a = document.createElement('a')
a.href = URL.createObjectURL(blob); a.download = '<uuid>.json'; a.click()
```

Do not write into OPFS while a ChronoWhoop tab is live — it holds the
`chronowhoop-storage` Web Lock as the single writer; close the app tab first
(a second app tab shows the read-only notice for the same reason).

## `.corrupt.<ts>` recovery

A file that fails parsing/validation is quarantined: raw bytes copied to
`<name>.corrupt.<ts>`, original removed, a dismissable warning shown (ADR
0010). One bad session file loses one session, never the app. To attempt
recovery:

1. Find it: list the root / `sessions/` as above — quarantine files keep the
   full original name plus the `.corrupt.<ts>` suffix.
2. Download the bytes via the console snippet (change the file name; use the
   root directory handle for a quarantined `courses.json`).
3. Inspect/fix the JSON by hand (truncation from a crashed write is the
   expected shape; the schema is `docs/specs/storage.md`).
4. Re-import: wrap the repaired session in an export envelope
   (`{ schemaVersion, exportedAt, courses: [], settings: { speechEnabled: true },
   sessions: [<session>] }` with the app's current schemaVersion — the parser
   requires a `settings` field, but its value is inert: local settings always
   win on import) and use Home → Import — it merges by id
   through the same validation as any read, so a bad repair is refused, not
   half-applied. Re-placing the file directly with `createWritable()` also
   works (close the app tab first) but skips no validation on the next read —
   the importer is the safer path.
5. Delete the quarantine file once recovered (or keep it; reads ignore
   non-`.json` names).

Note: a file refused as `unsupported-version` (schemaVersion newer than the
app) is NOT quarantined — it stays in place untouched; update the app instead
of editing the file.
