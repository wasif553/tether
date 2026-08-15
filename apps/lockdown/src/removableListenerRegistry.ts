/**
 * Tether v1.7.6 pre-commit audit fix — a tiny, generic, dependency-free
 * helper for preload bridge listeners that need a real unsubscribe.
 *
 * The older onDisplayEnforcementEvent/onLockdownCapabilityTransition/
 * onRemoteSessionMonitorEvent listeners elsewhere in preload.ts have no
 * removal mechanism at all (by existing precedent — the exam page
 * registers them once per submission and relies on a stable effect
 * dependency array to avoid re-registering, never removes them). The new
 * Native Display State Bridge's onDisplayEnforcementStateChanged
 * deliberately does NOT repeat that limitation: a remount/reload must be
 * able to remove exactly its own callback, so a stale closure referencing
 * an unmounted render's setState can never keep firing, and duplicate
 * registrations can never accumulate.
 *
 * Deliberately minimal — no event names, no wildcard/`*` subscriptions,
 * no priority ordering, no error isolation between listeners. Just add/
 * remove/emit for exactly one channel's worth of listeners.
 */
export function createRemovableListenerRegistry<T>() {
  const listeners: Array<(value: T) => void> = [];

  return {
    /** Registers a listener; returns a function that removes EXACTLY this listener (calling it more than once is a harmless no-op). */
    add(callback: (value: T) => void): () => void {
      listeners.push(callback);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const index = listeners.indexOf(callback);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    /** Calls every currently-registered listener with `value`, in registration order. */
    emit(value: T): void {
      for (const listener of listeners) listener(value);
    },
    /** Current listener count — exposed only for tests; production code never needs to inspect this. */
    get size(): number {
      return listeners.length;
    },
  };
}
