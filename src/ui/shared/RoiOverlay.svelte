<script lang="ts">
  import type { CaptureSession } from './capture-session'
  import { beginRoiDrag, dragRoi, hitTestRoi, type RoiDrag } from './roi-interaction'

  let { session }: { session: CaptureSession } = $props()

  const HANDLE_RADIUS_PX = 14

  let overlayEl = $state<HTMLDivElement | null>(null)
  let drag: RoiDrag | null = null

  const roi = $derived(session.tunables.roi)

  function pointerToNormalized(event: PointerEvent) {
    const bounds = overlayEl!.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
      tolerance: { x: HANDLE_RADIUS_PX / bounds.width, y: HANDLE_RADIUS_PX / bounds.height },
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (!overlayEl) return
    const point = pointerToNormalized(event)
    const handle = hitTestRoi(roi, point.x, point.y, point.tolerance)
    if (handle === null) return
    drag = beginRoiDrag(roi, handle, point.x, point.y)
    overlayEl.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent) {
    if (drag === null || !overlayEl) return
    const point = pointerToNormalized(event)
    session.setRoi(dragRoi(drag, point.x, point.y))
  }

  function onPointerEnd(event: PointerEvent) {
    if (drag === null || !overlayEl) return
    drag = null
    if (overlayEl.hasPointerCapture(event.pointerId)) {
      overlayEl.releasePointerCapture(event.pointerId)
    }
  }
</script>

<div
  class="overlay"
  role="application"
  aria-label="Region of interest — drag to move, drag a corner to resize"
  bind:this={overlayEl}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerEnd}
  onpointercancel={onPointerEnd}
>
  <div
    class="roi"
    style:left={`${roi.x * 100}%`}
    style:top={`${roi.y * 100}%`}
    style:width={`${roi.width * 100}%`}
    style:height={`${roi.height * 100}%`}
  >
    <!-- Only the corners are drag handles (roi-interaction hit-tests
         corners; elsewhere drags move the whole rect). The edge midpoints
         are the mockup's visual dressing, not extra interactions. -->
    <span class="handle nw"></span>
    <span class="handle ne"></span>
    <span class="handle sw"></span>
    <span class="handle se"></span>
    <span class="handle n"></span>
    <span class="handle s"></span>
    <span class="handle w"></span>
    <span class="handle e"></span>
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    touch-action: none;
    cursor: crosshair;
    overflow: hidden;
  }

  /* Mockup .roi: dashed cyan with a faint cyan wash; the dark outside mask is
     kept — it reads as "this is the watched region" on a live preview. */
  .roi {
    position: absolute;
    border: 1.5px dashed var(--c-signal);
    border-radius: 4px;
    background: rgba(51, 222, 207, 0.05);
    box-shadow: 0 0 0 9999px rgb(0 0 0 / 35%);
    box-sizing: border-box;
  }

  .handle {
    position: absolute;
    width: 12px;
    height: 12px;
    background: var(--c-signal);
    border: 2px solid var(--c-ground);
    border-radius: 3px;
    transform: translate(-50%, -50%);
  }

  .nw {
    left: 0;
    top: 0;
  }

  .ne {
    left: 100%;
    top: 0;
  }

  .sw {
    left: 0;
    top: 100%;
  }

  .se {
    left: 100%;
    top: 100%;
  }

  .n {
    left: 50%;
    top: 0;
  }

  .s {
    left: 50%;
    top: 100%;
  }

  .w {
    left: 0;
    top: 50%;
  }

  .e {
    left: 100%;
    top: 50%;
  }
</style>
