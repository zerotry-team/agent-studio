import { describe, expect, it } from "vitest";
import { nextScheduleAt } from "./schedules.js";

describe("nextScheduleAt", () => {
  it("uses Japan time and chooses today when the time is still ahead", () => {
    const now = new Date("2026-09-20T00:00:00.000Z"); // Sunday 09:00 JST
    expect(nextScheduleAt(now, "10:30", [0]).toISOString()).toBe("2026-09-20T01:30:00.000Z");
  });

  it("moves to the next selected weekday after today's time passed", () => {
    const now = new Date("2026-09-20T03:00:00.000Z"); // Sunday 12:00 JST
    expect(nextScheduleAt(now, "09:00", [1]).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});
