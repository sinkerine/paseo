import { describe, expect, it, vi } from "vitest";
import { createEndLanding } from "./end-landing";

function harness() {
  let sequence = 0;
  const frames = new Map<number, () => void>();
  const geometry = { ready: true, atEnd: false };
  const onSettled = vi.fn();
  const landing = createEndLanding({
    read: () => geometry,
    requestFrame: (callback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    onSettled,
  });
  function tick(count = 1) {
    for (let index = 0; index < count; index += 1) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    }
  }
  return { landing, geometry, frames, onSettled, tick };
}

describe("end landing", () => {
  it("requires two consecutive eligible end frames and releases before notifying", () => {
    const h = harness();
    h.onSettled.mockImplementation(() => expect(h.landing.isActive()).toBe(false));
    h.landing.start();
    h.geometry.atEnd = true;
    h.tick();
    h.geometry.atEnd = false;
    h.tick();
    h.geometry.atEnd = true;
    h.tick();
    expect(h.onSettled).not.toHaveBeenCalled();
    h.tick();
    expect(h.onSettled).toHaveBeenCalledOnce();
    h.tick(100);
    expect(h.onSettled).toHaveBeenCalledOnce();
  });

  it("expires after 60 eligible frames despite ongoing growth", () => {
    const h = harness();
    h.landing.start();
    h.tick(59);
    expect(h.landing.isActive()).toBe(true);
    h.tick();
    expect(h.onSettled).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
  });

  it("does not consume hidden or stale geometry frames", () => {
    const h = harness();
    h.geometry.ready = false;
    h.landing.start();
    h.tick(100);
    expect(h.landing.isActive()).toBe(true);
    h.geometry.ready = true;
    h.tick(59);
    expect(h.onSettled).not.toHaveBeenCalled();
    h.tick();
    expect(h.onSettled).toHaveBeenCalledOnce();
  });

  it("restarts the budget and ignores late callbacks from superseded requests", () => {
    const h = harness();
    h.landing.start();
    h.tick(59);
    const stale = [...h.frames.values()][0]!;
    h.landing.start();
    stale();
    h.tick(59);
    expect(h.onSettled).not.toHaveBeenCalled();
    h.tick();
    expect(h.onSettled).toHaveBeenCalledOnce();
  });

  it("cancels without settlement even when an already queued callback runs", () => {
    const h = harness();
    h.landing.start();
    const stale = [...h.frames.values()][0]!;
    h.landing.cancel();
    stale();
    h.tick(100);
    expect(h.onSettled).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
    expect(h.landing.isActive()).toBe(false);
  });
});
