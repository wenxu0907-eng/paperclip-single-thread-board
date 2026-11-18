// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelProvider } from "../context/PanelContext";
import { ScrollToBottom } from "./ScrollToBottom";

function act(callback: () => void) {
  flushSync(callback);
}

async function waitForButton(container: HTMLElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Scroll to bottom"]');
    if (button) return button;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("scroll-to-bottom button never became visible");
}

// Manual requestAnimationFrame pump so the self-correcting chase runs
// deterministically under jsdom (which has no layout / real rAF timing).
let rafQueue: FrameRequestCallback[] = [];
let clock = 0;

function flushFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    const batch = rafQueue;
    rafQueue = [];
    clock += 16;
    for (const cb of batch) cb(clock);
    if (batch.length === 0) break;
  }
}

// jsdom ships no ResizeObserver. Stub a controllable one so tests can simulate
// content growing under a stationary scroller.
let resizeObserverCallbacks: ResizeObserverCallback[] = [];

function triggerResizeObservers() {
  for (const cb of resizeObserverCallbacks) {
    cb([], {} as ResizeObserver);
  }
}

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeObserverCallbacks = resizeObserverCallbacks.filter((cb) => cb !== this.callback);
  }
}

describe("ScrollToBottom", () => {
  let container: HTMLDivElement;
  let root: Root;
  let main: HTMLDivElement;
  let scrollTop = 0;
  let scrollHeight = 0;
  const CLIENT_HEIGHT = 500;
  const MAX_HEIGHT = 5000;

  beforeEach(() => {
    rafQueue = [];
    resizeObserverCallbacks = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    clock = 0;
    scrollTop = 0;
    scrollHeight = 2000; // initial (under-)estimate, as the virtualizer would report

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      if (el === main) return { overflowY: "auto" } as CSSStyleDeclaration;
      return realGetComputedStyle(el, pseudo ?? undefined);
    });

    main = document.createElement("div");
    main.id = "main-content";
    main.style.overflowY = "auto";
    Object.defineProperty(main, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
    Object.defineProperty(main, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(main, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = Math.max(0, Math.min(v, scrollHeight - CLIENT_HEIGHT));
      },
    });
    // Simulate virtualized growth: every scroll toward the bottom measures more
    // rows into view, so scrollHeight keeps climbing until it caps out.
    main.scrollTo = ((opts: ScrollToOptions) => {
      main.scrollTop = opts.top ?? 0;
      scrollHeight = Math.min(MAX_HEIGHT, scrollHeight + 300);
    }) as typeof main.scrollTo;
    document.body.appendChild(main);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    main.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reaches the true bottom in one click even as content grows mid-scroll", async () => {
    act(() => {
      root.render(
        <PanelProvider>
          <ScrollToBottom />
        </PanelProvider>,
      );
    });

    const button = await waitForButton(container);

    act(() => button.click());
    flushFrames(60);

    // Final scroll position is the true (fully grown) bottom, not the stale
    // estimate a single scrollTo(2000 - 500 = 1500) would have produced.
    expect(scrollHeight).toBe(MAX_HEIGHT);
    expect(scrollTop).toBe(MAX_HEIGHT - CLIENT_HEIGHT);
    expect(scrollTop).toBeGreaterThan(1500);
  });

  it("stops chasing once the bottom is stable (does not loop forever)", async () => {
    act(() => {
      root.render(
        <PanelProvider>
          <ScrollToBottom />
        </PanelProvider>,
      );
    });
    const button = await waitForButton(container);

    act(() => button.click());
    flushFrames(60);
    const settledCalls = rafQueue.length;
    flushFrames(10);
    // No new frames were scheduled after settling.
    expect(rafQueue.length).toBe(settledCalls);
    expect(scrollTop).toBe(MAX_HEIGHT - CLIENT_HEIGHT);
  });

  // COM-374: the chase used to abort when scrollTop moved backwards by >120px,
  // assuming that meant the user scrolled up. The virtualizer legitimately
  // corrects the offset by several hundred px while rows measure in, so that
  // heuristic stopped the click partway down and the user had to click again.
  it("keeps chasing through a backwards offset correction from the virtualizer", async () => {
    act(() => {
      root.render(
        <PanelProvider>
          <ScrollToBottom />
        </PanelProvider>,
      );
    });
    const button = await waitForButton(container);

    act(() => button.click());
    flushFrames(3);

    // Simulate the virtualizer re-measuring and yanking the offset back up.
    scrollTop = Math.max(0, scrollTop - 400);
    flushFrames(60);

    expect(scrollTop).toBe(MAX_HEIGHT - CLIENT_HEIGHT);
  });

  it("hands the scroller back as soon as the user takes over", async () => {
    act(() => {
      root.render(
        <PanelProvider>
          <ScrollToBottom />
        </PanelProvider>,
      );
    });
    const button = await waitForButton(container);

    act(() => button.click());
    flushFrames(2);

    act(() => {
      main.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    const stoppedAt = scrollTop;
    flushFrames(60);

    // The chase released the scroller instead of fighting the user back down.
    expect(scrollTop).toBe(stoppedAt);
    expect(scrollTop).toBeLessThan(MAX_HEIGHT - CLIENT_HEIGHT);
  });

  // COM-374 follow-up: on a live task the thread grows underneath a stationary
  // scroller while a run streams rows in. That fires neither `scroll` nor
  // `resize`, so a purely event-driven visibility check left the arrow hidden
  // while the user was thousands of px from the end — the board's "I used the
  // floating arrow and it is not working" (there was no arrow to click).
  it("appears when content grows below the fold without a scroll or resize", async () => {
    act(() => {
      root.render(
        <PanelProvider>
          <ScrollToBottom />
        </PanelProvider>,
      );
    });

    // Park the user at the true bottom: the arrow is correctly hidden.
    act(() => {
      main.scrollTop = scrollHeight - CLIENT_HEIGHT;
      main.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();

    // A run streams new rows in: content height grows, scrollTop stays put.
    // No scroll/resize event is dispatched — only the ResizeObserver fires.
    act(() => {
      scrollHeight += 4000;
      triggerResizeObservers();
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Scroll to bottom"]');
    expect(button).not.toBeNull();

    // And it still takes the user to the true end.
    act(() => button!.click());
    flushFrames(60);
    expect(scrollTop).toBe(scrollHeight - CLIENT_HEIGHT);
  });
});
