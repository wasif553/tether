import { describe, it, expect, vi } from "vitest";
import { createRemovableListenerRegistry } from "./removableListenerRegistry";

// Tether v1.7.6 pre-commit audit fix — behavioral coverage for the
// listener-cleanup mechanism backing window.sesLockdown's
// onDisplayEnforcementStateChanged. See preload.ts's own doc comment for
// why this exists: the OLDER onDisplayEnforcementEvent-style listeners
// have no removal mechanism at all; this one must not repeat that.

describe("createRemovableListenerRegistry — listener cleanup (Part 4.E/F)", () => {
  it("a registered listener receives every emitted value", () => {
    const registry = createRemovableListenerRegistry<number>();
    const received: number[] = [];
    registry.add((v) => received.push(v));
    registry.emit(1);
    registry.emit(2);
    expect(received).toEqual([1, 2]);
  });

  it("the returned unsubscribe function removes EXACTLY that listener — E: cleanup removes the listener", () => {
    const registry = createRemovableListenerRegistry<number>();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = registry.add(a);
    registry.add(b);
    expect(registry.size).toBe(2);

    unsubscribeA();
    expect(registry.size).toBe(1);

    registry.emit(42);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(42);
  });

  it("calling the unsubscribe function more than once is a harmless no-op — never removes a DIFFERENT, later listener that happens to occupy the same array slot", () => {
    const registry = createRemovableListenerRegistry<number>();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = registry.add(a);
    unsubscribeA();
    registry.add(b); // could land at the same index `a` used to occupy
    unsubscribeA(); // must not remove `b`
    registry.emit(1);
    expect(b).toHaveBeenCalledWith(1);
  });

  it("F: a remount/reload cycle (add, remove, add again) never accumulates duplicate effective listeners — exactly one call per emit after re-registration", () => {
    const registry = createRemovableListenerRegistry<number>();
    const callback = vi.fn();
    const unsubscribeFirst = registry.add(callback);
    unsubscribeFirst(); // simulates the first mount's effect cleanup
    registry.add(callback); // simulates a remount registering the "same" callback again (a fresh closure in real React, but a plain function reference is enough to prove non-accumulation here)

    registry.emit(7);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it("F: registering the same callback reference twice without ever unsubscribing genuinely does add two entries — proving the registry itself doesn't silently dedupe (correctness depends on the CALLER always unsubscribing on cleanup, not on this registry masking a leak)", () => {
    const registry = createRemovableListenerRegistry<number>();
    const callback = vi.fn();
    registry.add(callback);
    registry.add(callback);
    expect(registry.size).toBe(2);
    registry.emit(1);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("an unsubscribed listener never fires again, even if other listeners are added/removed afterward", () => {
    const registry = createRemovableListenerRegistry<string>();
    const removed = vi.fn();
    const stillActive = vi.fn();
    const unsubscribeRemoved = registry.add(removed);
    unsubscribeRemoved();
    registry.add(stillActive);
    registry.emit("hello");
    expect(removed).not.toHaveBeenCalled();
    expect(stillActive).toHaveBeenCalledWith("hello");
  });
});
