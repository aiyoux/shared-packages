# `@shared-packages/video`

Browser video **trim / resize / export** with lazy engines:

- **native** — WebCodecs + mediabunny (H.264 MP4, Chromium)
- **ffmpeg** — `@ffmpeg/ffmpeg` WASM core, loaded only when selected (MP4 or WebM)

and reusable editor/player UI.

Product chrome (attach-to-sign, RIFE bridge, dictionary captions) stays in the consumer.

## API

```ts
import { processVideo, getVideoDuration, createVideoUrl } from '@shared-packages/video';

const clip = await processVideo(blob, { start: 0.5, end: 3.2, bitrate: '1M' });
const out = await exportVideo('ffmpeg', blob, {
  start: 0,
  end: 4,
  format: 'webm',
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

## Publish

```bash
npm run yalc:publish -w @shared-packages/video
```
