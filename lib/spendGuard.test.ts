import { describe, expect, it } from "vitest";
import { CapacityError, createSpendGuard } from "./spendGuard";

describe("createSpendGuard", () => {
  it("allows up to the cap", () => {
    const guard = createSpendGuard(2);
    guard.acquire();
    guard.acquire();
    expect(guard.inFlight()).toBe(2);
  });

  it("rejects past the cap", () => {
    const guard = createSpendGuard(2);
    guard.acquire();
    guard.acquire();
    expect(() => guard.acquire()).toThrow(CapacityError);
  });

  it("frees a slot on release", () => {
    const guard = createSpendGuard(1);
    const release = guard.acquire();
    expect(() => guard.acquire()).toThrow(CapacityError);
    release();
    expect(guard.inFlight()).toBe(0);
    expect(() => guard.acquire()).not.toThrow();
  });

  it("ignores a double release", () => {
    // The route releases in a finally that can run twice on some abort paths.
    // Counting that twice would hand out more capacity than the cap allows.
    const guard = createSpendGuard(1);
    const release = guard.acquire();
    release();
    release();
    expect(guard.inFlight()).toBe(0);
    guard.acquire();
    expect(() => guard.acquire()).toThrow(CapacityError);
  });

  it("does not go negative when releases outnumber acquires", () => {
    const guard = createSpendGuard(2);
    const a = guard.acquire();
    const b = guard.acquire();
    a();
    b();
    a();
    b();
    expect(guard.inFlight()).toBe(0);
  });
});
