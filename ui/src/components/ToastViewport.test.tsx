// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to?: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastViewport", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an onClick action as a button and invokes the callback (Undo)", () => {
    const root = createRoot(container);
    const onUndo = vi.fn();
    let push: ReturnType<typeof useToastActions>["pushToast"] | null = null;

    function Harness() {
      push = useToastActions().pushToast;
      return <ToastViewport />;
    }

    act(() => {
      root.render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
    });

    act(() => {
      push?.({ title: "Marked reviewed", action: { label: "Undo", onClick: onUndo } });
    });

    const buttons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent === "Undo",
    );
    expect(buttons.length).toBe(1);

    act(() => {
      buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
    // Toast is dismissed after the action fires.
    expect(
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Undo"),
    ).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("renders an href action as a link", () => {
    const root = createRoot(container);
    let push: ReturnType<typeof useToastActions>["pushToast"] | null = null;

    function Harness() {
      push = useToastActions().pushToast;
      return <ToastViewport />;
    }

    act(() => {
      root.render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
    });

    act(() => {
      push?.({ title: "Saved", action: { label: "View", href: "/somewhere" } });
    });

    const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent === "View");
    expect(link).not.toBeUndefined();
    expect(link?.getAttribute("href")).toBe("/somewhere");

    act(() => {
      root.unmount();
    });
  });
});
