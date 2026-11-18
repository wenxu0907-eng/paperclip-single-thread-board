import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { cn } from "../lib/utils";
import {
  chaseScrollToPageEnd,
  distanceFromPageBottom,
  resolvePageScrollTarget,
} from "../lib/scroll-to-page-end";

/**
 * Floating scroll-to-bottom button that follows the active page scroller.
 * On desktop that is `#main-content`; on mobile it falls back to window/page scroll.
 *
 * The actual scrolling lives in `lib/scroll-to-page-end` so this button and the
 * thread's `Jump to latest` control share one implementation (COM-374).
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);
  const { panelVisible, panelContent } = usePanel();
  const cancelChaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromPageBottom(resolvePageScrollTarget()) > 300);
    };

    const mainContent = document.getElementById("main-content");

    check();
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    // Scroll/resize events alone leave the button stale: on a live task the
    // thread grows underneath a stationary scroller (a run streams new rows in),
    // which fires neither. The distance to the bottom jumps from 0 to thousands
    // of px and the arrow never appears — "I used the floating arrow and it is
    // not working", because there was nothing to click (COM-374).
    //
    // Watch the scroll host and its content boxes instead, so the button tracks
    // content growth as well as user scrolling.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    const observed = new Set<Element>();
    const observe = (element: Element | null | undefined) => {
      if (!element || !resizeObserver || observed.has(element)) return;
      observed.add(element);
      resizeObserver.observe(element);
    };

    const syncObservedContent = () => {
      // The scroll host itself covers viewport-box changes; its children are the
      // content whose height actually moves the bottom.
      observe(mainContent);
      observe(document.body);
      for (const child of mainContent?.children ?? []) observe(child);
      check();
    };

    syncObservedContent();

    // The content wrapper inside `#main-content` is remounted on navigation, so
    // re-attach the observer when the subtree is replaced.
    let mutationObserver: MutationObserver | null = null;
    if (mainContent && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(syncObservedContent);
      mutationObserver.observe(mainContent, { childList: true });
    }

    return () => {
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      cancelChaseRef.current?.();
      cancelChaseRef.current = null;
    };
  }, []);

  const scroll = useCallback(() => {
    cancelChaseRef.current?.();
    cancelChaseRef.current = chaseScrollToPageEnd({
      onSettled: () => {
        cancelChaseRef.current = null;
      },
    });
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
