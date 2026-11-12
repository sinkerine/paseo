/** @vitest-environment jsdom */
import { useCallback, useState, type PointerEvent, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";
import { BtwPill } from "./pill";
import { btwWindowKey, useBtwWindowStore } from "./window-store";

vi.mock("./select", () => ({ useBtwThread: () => ({ id: "thread", status: "completed" }) }));
vi.mock("@/composer/tracks", () => ({ ComposerTrackMark: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const focus = vi.fn();
const key = btwWindowKey("host", "owner", "thread");
function Pane({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  const focusPane = useCallback(() => {
    focus();
    setFocused(true);
  }, []);
  const capture = useCallback(
    (event: PointerEvent) => {
      if (shouldFocusPaneFromEventTarget(event.target)) focusPane();
    },
    [focusPane],
  );
  const blur = useCallback(() => setFocused(false), []);
  return (
    <div onPointerDownCapture={capture}>
      <PaneFocusProvider
        value={createPaneFocusContextValue({
          isWorkspaceFocused: true,
          isPaneFocused: focused,
          onFocusPane: focusPane,
        })}
      >
        {children}
      </PaneFocusProvider>
      <button type="button" onClick={blur}>
        Other pane
      </button>
    </div>
  );
}
beforeEach(() => {
  focus.mockReset();
  useBtwWindowStore.setState({ byThread: { [key]: "open" } });
});
afterEach(cleanup);

test("an unfocused split-pane chip opens on first activation, with capture-phase focus excluded", () => {
  render(
    <Pane>
      <BtwPill serverId="host" agentId="owner" />
    </Pane>,
  );
  const chip = screen.getByTestId("btw-chip");
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  expect(chip.getAttribute("aria-label")).toBe("btw.show");
  fireEvent.pointerDown(chip.firstChild ?? chip);
  expect(focus).not.toHaveBeenCalled();
  fireEvent.click(chip);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(useBtwWindowStore.getState().byThread[key]).toBe("open");
  fireEvent.click(chip);
  expect(useBtwWindowStore.getState().byThread[key]).toBe("minimized");
  fireEvent.click(chip);
  fireEvent.click(screen.getByText("Other pane"));
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(chip); // Native/accessibility activation has no preceding DOM pointerdown.
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(useBtwWindowStore.getState().byThread[key]).toBe("open");
});

test("the sheet header hides the open window independently of host pane focus", () => {
  render(
    <Pane>
      <BtwPill serverId="host" agentId="owner" header />
    </Pane>,
  );
  const chip = screen.getByTestId("btw-sheet-chip");
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(chip);
  expect(focus).not.toHaveBeenCalled();
  expect(useBtwWindowStore.getState().byThread[key]).toBe("minimized");
  act(() => useBtwWindowStore.getState().setMode(key, "open"));
  expect(chip.getAttribute("aria-expanded")).toBe("true");
});
