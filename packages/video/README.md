# `@shared-packages/video`

Browser video **trim / resize / export** with WebCodecs + mediabunny (H.264 MP4, Chromium) and reusable editor/player UI.

Product chrome (attach-to-sign, RIFE bridge, dictionary captions) stays in the consumer.

## API

```ts
import { processVideo, getVideoDuration, createVideoUrl } from '@shared-packages/video';

const clip = await processVideo(blob, { start: 0.5, end: 3.2, bitrate: '1M' });
const out = await exportVideo('native', blob, {
  start: 0,
  end: 4,
  format: 'mp4',
  bitrate: '1M',
  name: 'clip.mp4'
});
```

Svelte (deep imports — do not pull the barrel from extra's svelte-check):

```ts
import VideoTimeline from '@shared-packages/video/VideoTimeline.svelte';
import VideoTransport from '@shared-packages/video/VideoTransport.svelte';
import VideoProcessPanel from '@shared-packages/video/VideoProcessPanel.svelte';
import VideoPlayer from '@shared-packages/video/VideoPlayer.svelte';
import VideoLightbox from '@shared-packages/video/VideoLightbox.svelte';
```

`VideoProcessPanel` accepts an optional `interpolator` for a local RIFE-style post-step.

## Players — use the system, don't hand-roll

Every playback surface uses one of these. Do not ship a bare
`<video controls>`, and do not write a bespoke scrub loop that sets
`currentTime` on every pointer move — both freeze on slow decoders, and one-off
bars drift apart visually. The shared row and engine:

- `VideoLightbox` — single clip preview (cards, modals, record/review
  outputs). Smooth scrub, speed, captions, optional space hotkey. Pass
  `hotkeys={false}` when embedding in a page or list so space keeps
  scrolling, and `muted={false}` only for clips whose sound matters.
- `VideoPlayer` — looping playback with a cooldown badge and speed buttons
  (flashcards). Same smooth-scrub engine.
- `VideoTransport` + `VideoTimeline` — trim preview for editors: plays the
  kept range, then the timeline owns handles, slip and zoom.
- `MediaControlsBar` — the play + scrub + speed row the above are built on.
  Always pass the element as `media` so seeks pause, coalesce and resume.
- `FeVideoPlayer` / `FeAudioPlayer` (`@shared-packages/file-system`) — file
  preview with ranged/converted streams, volume, PiP and fullscreen.

Pure seek decisions live in `scrubSeek.ts` (`clampScrubTarget`,
`shouldDeferScrubSeek`, `scrubDisplayTime`): intermediate drag positions defer
while the element is seeking; the release position always applies.

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run `npm install` in a consumer only when `exports` change.
