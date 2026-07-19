import { describe, expect, it } from "vitest";

import { SessionRegistry, type Session } from "../src/session.ts";

class FakeSession implements Session {
  constructor(readonly id: string) {}
}

describe("SessionRegistry", () => {
  it("returns undefined when empty", () => {
    const registry = new SessionRegistry<FakeSession>();
    expect(registry.take()).toBeUndefined();
  });

  it("stores and takes a session atomically", () => {
    const registry = new SessionRegistry<FakeSession>();
    const session = new FakeSession("s1");
    registry.set(session);
    expect(registry.take()).toBe(session);
    // take() clears the slot: a second take returns nothing.
    expect(registry.take()).toBeUndefined();
  });

  it("set returns undefined when the slot was empty", () => {
    const registry = new SessionRegistry<FakeSession>();
    expect(registry.set(new FakeSession("s1"))).toBeUndefined();
  });

  it("set returns the previously-pending (displaced) session", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = new FakeSession("s1");
    const second = new FakeSession("s2");
    registry.set(first);
    const displaced = registry.set(second);
    // The displaced session is returned so the caller can finalize/warn about it
    // instead of silently dropping it.
    expect(displaced).toBe(first);
    expect(registry.take()).toBe(second);
  });

  it("a second set replaces the pending session", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = new FakeSession("s1");
    const second = new FakeSession("s2");
    registry.set(first);
    registry.set(second);
    // The latest wins; the previous one is dropped (no stacking).
    expect(registry.take()).toBe(second);
    expect(registry.take()).toBeUndefined();
  });

  it("reset clears the slot without returning it", () => {
    const registry = new SessionRegistry<FakeSession>();
    registry.set(new FakeSession("s1"));
    registry.reset();
    expect(registry.take()).toBeUndefined();
  });
});