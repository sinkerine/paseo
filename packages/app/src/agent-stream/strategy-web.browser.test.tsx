import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { DisclosureTriggerEdge, StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VIEWPORT_HEIGHT = 100;
const ROW_HEIGHT = 40;

// A row's height comes from its text, so a disclosure that opens or grows a row is a new item
// for that row, as it is in the app.
function row(index: number, height = ROW_HEIGHT): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: String(height),
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

const rowStyleByHeight = new Map<number, { height: number }>();

function renderRow(item: StreamItem) {
  const height = item.kind === "user_message" ? Number(item.text) : ROW_HEIGHT;
  let style = rowStyleByHeight.get(height);
  if (!style) {
    style = { height };
    rowStyleByHeight.set(height, style);
  }
  return <div style={style}>{item.id}</div>;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:500px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mountTimeline(historyMounted: StreamItem[]) {
  const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const input: StreamRenderInput = {
    agentId: "agent",
    segments: { historyVirtualized: [], historyMounted, liveHead: [] },
    boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
    renderers: {
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: () => null,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearBottomChange: () => {},
    onNearHistoryStart: async () => true,
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: null,
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
    contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
  };
  const render = (segments: Partial<StreamRenderInput["segments"]>) =>
    root.render(strategy.render({ ...input, segments: { ...input.segments, ...segments } }));
  act(() => render({}));

  const scrollContainer = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!scrollContainer) throw new Error("Expected agent chat scroll container");
  const rowElement = (id: string) => {
    const element = host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
    if (!element) throw new Error(`Expected row ${id}`);
    return element;
  };

  return {
    scrollContainer,
    viewportRef,
    render: (segments: Partial<StreamRenderInput["segments"]>) => act(() => render(segments)),
    hold: (rowId: string, apply: () => void, triggerEdge: DisclosureTriggerEdge = "top") =>
      act(() => viewportRef.current!.holdRow(rowId, apply, triggerEdge)),
    rowTop: (id: string) =>
      rowElement(id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
    rowBottom: (id: string) =>
      rowElement(id).getBoundingClientRect().bottom - scrollContainer.getBoundingClientRect().top,
    scrollTo: (top: number) => {
      scrollContainer.scrollTop = top;
    },
    distanceFromEnd: () =>
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    // Resize observers and the hold's settle run on animation frames.
    settle: () =>
      act(async () => {
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
  };
}

describe("web disclosure hold", () => {
  it("keeps the trigger's top when an anchored toggle at the bottom opens rows below it, and stops following", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 5), row(7, 200), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  it("keeps the trigger's top when its row grows while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  // A long message's show more sits under the text it opens, on the bottom edge of its row.
  it("keeps the bottom of a bottom-trigger row through show more and show less while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerBottom = timeline.rowBottom("message-5");

    timeline.hold(
      "message-5",
      () => timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
      "bottom",
    );
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }), "bottom");
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);
  });

  it("keeps the bottom of a bottom-trigger row through show more and show less when scrolled up", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.scrollTo(60);
    await timeline.settle();
    // message-2 is cut off at the top; message-3 is fully in view.
    for (const index of [2, 3]) {
      const triggerBottom = timeline.rowBottom(`message-${index}`);
      const grown = history.map((item, position) =>
        position === index - 1 ? row(index, 240) : item,
      );

      timeline.hold(`message-${index}`, () => timeline.render({ historyMounted: grown }), "bottom");
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);

      timeline.hold(
        `message-${index}`,
        () => timeline.render({ historyMounted: history }),
        "bottom",
      );
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);
    }
  });

  it("stays resting when collapsing an anchored row lands back at the end", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }));
    await timeline.settle();

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeGreaterThan(1);
  });
});

describe("bounded end landing", () => {
  it("lands once, keeps visible text fixed through growth, and offers another explicit landing", async () => {
    const history = Array.from({ length: 20 }, (_, index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const anchor = timeline.rowTop("message-18");
    const offset = timeline.scrollContainer.scrollTop;
    for (let count = 1; count <= 10; count += 1) {
      timeline.render({ liveHead: [row(30, count * 40)] });
      await timeline.settle();
      expect(Math.abs(timeline.scrollContainer.scrollTop - offset)).toBeLessThanOrEqual(1);
      expect(Math.abs(timeline.rowTop("message-18") - anchor)).toBeLessThanOrEqual(1);
    }
    expect(timeline.distanceFromEnd()).toBeGreaterThanOrEqual(300);
    act(() => timeline.viewportRef.current!.scrollToBottom());
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    const landedOffset = timeline.scrollContainer.scrollTop;
    timeline.render({ liveHead: [row(30, 800)] });
    await timeline.settle();
    expect(timeline.scrollContainer.scrollTop).toBe(landedOffset);
  });

  it("keeps an underfilled prompt at the top through overflow", async () => {
    const timeline = mountTimeline([row(1, 10)]);
    await timeline.settle();
    const top = timeline.rowTop("message-1");
    for (const height of [10, 30, 100, 400]) {
      timeline.render({ liveHead: [row(2, height)] });
      await timeline.settle();
      expect(timeline.rowTop("message-1")).toBe(top);
      expect(timeline.scrollContainer.scrollTop).toBe(0);
    }
  });

  it("cancels landing for downward viewport intent and never reattaches at the end", async () => {
    const timeline = mountTimeline(Array.from({ length: 20 }, (_, index) => row(index)));
    act(() => timeline.scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 })));
    timeline.scrollTo(timeline.scrollContainer.scrollHeight);
    await timeline.settle();
    const offset = timeline.scrollContainer.scrollTop;
    timeline.render({ liveHead: [row(30, 400)] });
    await timeline.settle();
    expect(timeline.scrollContainer.scrollTop).toBe(offset);
    expect(timeline.distanceFromEnd()).toBeGreaterThan(300);
  });
});
