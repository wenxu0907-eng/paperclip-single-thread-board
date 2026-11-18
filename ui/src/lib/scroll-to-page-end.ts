// Single source of truth for "take me to the end of the page".
//
// Two controls in the issue UI mean the same thing and must behave identically:
//   * the floating arrow button (`ScrollToBottom`)
//   * the `Jump to latest` text button in `IssueChatThread`
//
// COM-374: they used to have separate implementations. The arrow was fixed to
// chase the true page end, while `Jump to latest` kept aligning the *last
// comment row* to the container bottom — which is short by everything rendered
// below it (trailing run/system rows, the sticky composer, page padding), and
// because that target is fixed, extra clicks never closed the gap. Both now
// call `chaseScrollToPageEnd` so the behaviour can never drift apart again.

export type PageScrollTarget =
  | { type: "element"; element: HTMLElement }
  | { type: "window" };

/**
 * The issue page scrolls `#main-content` on desktop (`overflow-auto`) and the
 * document itself on mobile (`overflow-visible`). Resolve whichever is actually
 * scrollable right now.
 */
export function resolvePageScrollTarget(): PageScrollTarget {
  const mainContent = document.getElementById("main-content");

  if (mainContent instanceof HTMLElement) {
    const overflowY = window.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && mainContent.scrollHeight > mainContent.clientHeight + 1;

    if (usesOwnScroll) {
      return { type: "element", element: mainContent };
    }
  }

  return { type: "window" };
}

function activeScroller(target: PageScrollTarget): Element {
  if (target.type === "element") return target.element;
  return document.scrollingElement ?? document.documentElement;
}

export function distanceFromPageBottom(target: PageScrollTarget = resolvePageScrollTarget()) {
  if (target.type === "element") {
    return target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollHeight - window.scrollY - window.innerHeight;
}

function scrollToBottomOnce(target: PageScrollTarget, behavior: ScrollBehavior) {
  if (target.type === "element") {
    target.element.scrollTo({ top: target.element.scrollHeight, behavior });
    return;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  window.scrollTo({ top: scroller.scrollHeight, behavior });
}

// The issue thread is virtualized (see IssueChatThread): rows below the viewport
// are rendered from an estimated height and only measured for real as they scroll
// into view, so `scrollHeight` keeps growing while a scroll is in flight. A single
// `scrollTo(scrollHeight)` therefore lands short of the true bottom — the reported
// "click doesn't reach the end, need several clicks" bug. Instead we chase the
// *current* bottom across animation frames until the height stabilizes, stopping
// when the user takes the scroller back or after a safety cap.
const SETTLE_THRESHOLD_PX = 4;
const REQUIRED_STABLE_FRAMES = 4;
const MAX_DURATION_MS = 4000;

// Hand the scroller back the moment the user reaches for it. These are the
// direct-intent signals; we deliberately do NOT infer "the user scrolled up"
// from scrollTop moving backwards, because the virtualizer legitimately
// corrects the offset by several hundred px as rows measure in, and treating
// that as user intent aborted the chase partway down (COM-374).
const USER_INTERRUPT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export interface ChaseScrollToPageEndOptions {
  /** Called when the chase stops, however it stops. */
  onSettled?: () => void;
}

/**
 * Scroll the active page scroller to its true end and keep it pinned there while
 * virtualized rows measure in.
 *
 * Returns a cancel function. The chase also cancels itself as soon as the user
 * takes over (wheel, touch, pointer, or key).
 */
export function chaseScrollToPageEnd(options: ChaseScrollToPageEndOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const { onSettled } = options;
  const start = typeof performance !== "undefined" ? performance.now() : 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : start);

  let rafId: number | null = null;
  let lastHeight = -1;
  let stableFrames = 0;
  let cancelled = false;

  // Bind the user-interrupt listeners to whatever scrolls today; the target can
  // change mid-chase (resize), so listen on both the element and the window.
  const initialTarget = resolvePageScrollTarget();
  const interruptTargets: Array<EventTarget> =
    initialTarget.type === "element" ? [initialTarget.element, window] : [window];

  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    for (const target of interruptTargets) {
      for (const event of USER_INTERRUPT_EVENTS) {
        target.removeEventListener(event, stop);
      }
    }
    onSettled?.();
  };

  for (const target of interruptTargets) {
    for (const event of USER_INTERRUPT_EVENTS) {
      target.addEventListener(event, stop, { passive: true });
    }
  }

  const step = () => {
    if (cancelled) return;
    rafId = null;

    const target = resolvePageScrollTarget();
    const scroller = activeScroller(target);
    const height = scroller.scrollHeight;

    // Re-target the current bottom every frame; smooth on the first nudge for a
    // pleasant start, then instant so we stay pinned as content measures in.
    scrollToBottomOnce(target, stableFrames === 0 && lastHeight === -1 ? "smooth" : "auto");

    const settled = height === lastHeight && distanceFromPageBottom(target) <= SETTLE_THRESHOLD_PX;
    stableFrames = settled ? stableFrames + 1 : 0;
    lastHeight = height;

    if (stableFrames >= REQUIRED_STABLE_FRAMES || now() - start > MAX_DURATION_MS) {
      stop();
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  // Run the first step synchronously so the click produces immediate movement;
  // subsequent steps chase the (still growing) bottom frame by frame.
  step();

  return stop;
}
