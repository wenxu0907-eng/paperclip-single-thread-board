import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { cn } from "../lib/utils";

function resolveScrollTarget() {
  const mainContent = document.getElementById("main-content");

  if (mainContent instanceof HTMLElement) {
    const overflowY = window.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && mainContent.scrollHeight > mainContent.clientHeight + 1;

    if (usesOwnScroll) {
      return { type: "element" as const, element: mainContent };
    }
  }

  return { type: "window" as const };
}

function activeScroller(target: ReturnType<typeof resolveScrollTarget>): Element {
  if (target.type === "element") return target.element;
  return document.scrollingElement ?? document.documentElement;
}

function distanceFromBottom(target: ReturnType<typeof resolveScrollTarget>) {
  if (target.type === "element") {
    return target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollHeight - window.scrollY - window.innerHeight;
}

function scrollToBottomOnce(target: ReturnType<typeof resolveScrollTarget>, behavior: ScrollBehavior) {
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
// *current* bottom across animation frames until the height stabilizes, aborting if
// the user scrolls up or after a safety cap.
const SETTLE_THRESHOLD_PX = 4;
const REQUIRED_STABLE_FRAMES = 4;
const MAX_DURATION_MS = 4000;
// If the scroller moves this far above the furthest point we've reached, treat it
// as the user deliberately scrolling up and stop chasing.
const USER_SCROLL_UP_ABORT_PX = 120;

/**
 * Floating scroll-to-bottom button that follows the active page scroller.
 * On desktop that is `#main-content`; on mobile it falls back to window/page scroll.
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);
  const { panelVisible, panelContent } = usePanel();
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromBottom(resolveScrollTarget()) > 300);
    };

    const mainContent = document.getElementById("main-content");

    check();
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    return () => {
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const scroll = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);

    const start = typeof performance !== "undefined" ? performance.now() : 0;
    const now = () => (typeof performance !== "undefined" ? performance.now() : start);
    let lastHeight = -1;
    let maxScrollTop = -Infinity;
    let stableFrames = 0;
    let firstFrame = true;

    const step = () => {
      const target = resolveScrollTarget();
      const scroller = activeScroller(target);
      const scrollTop = target.type === "element" ? target.element.scrollTop : window.scrollY;
      const height = scroller.scrollHeight;

      // Abort if the user has scrolled meaningfully up from the furthest point we
      // reached (normal virtualized growth only ever increases scrollTop).
      if (!firstFrame && scrollTop < maxScrollTop - USER_SCROLL_UP_ABORT_PX) {
        rafRef.current = null;
        return;
      }
      firstFrame = false;
      maxScrollTop = Math.max(maxScrollTop, scrollTop);

      // Re-target the current bottom every frame; smooth on the first nudge for a
      // pleasant start, then instant so we stay pinned as content measures in.
      scrollToBottomOnce(target, stableFrames === 0 && lastHeight === -1 ? "smooth" : "auto");

      const settled = height === lastHeight && distanceFromBottom(target) <= SETTLE_THRESHOLD_PX;
      stableFrames = settled ? stableFrames + 1 : 0;
      lastHeight = height;

      if (stableFrames >= REQUIRED_STABLE_FRAMES || now() - start > MAX_DURATION_MS) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={scroll}
      className={cn(
        "fixed bottom-(--sz-calc-21) right-6 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-(--tp-background-color-right) duration-200 md:bottom-6",
        panelVisible && panelContent && "md:right-(--sz-calc-22)",
      )}
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
