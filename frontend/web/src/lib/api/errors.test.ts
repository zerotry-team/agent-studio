import { describe, expect, it } from "vitest";
import { fieldErrorsFromDetails, toApiError } from "./errors";

describe("fieldErrorsFromDetails", () => {
  it("reads several detail shapes", () => {
    expect(fieldErrorsFromDetails([{ path: "a.b", message: "m1" }])).toEqual({ "a.b": "m1" });
    expect(fieldErrorsFromDetails({ issues: [{ path: ["spec", "url"], message: "m2" }] })).toEqual({ "spec.url": "m2" });
    expect(fieldErrorsFromDetails({ fieldErrors: { name: ["m3", "m4"] } })).toEqual({ name: "m3" });
    expect(fieldErrorsFromDetails("oops")).toBeUndefined();
    expect(fieldErrorsFromDetails({})).toBeUndefined();
  });
});

describe("toApiError", () => {
  it("falls back to the status message when the API message is empty", () => {
    const err = toApiError(409, { error: { code: "conflict", message: "" } });
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/重なりました/);
  });
});
