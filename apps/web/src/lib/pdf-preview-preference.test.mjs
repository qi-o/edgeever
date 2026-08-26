import { describe, expect, test } from "bun:test";
import { resolvePdfPreviewPreference } from "./pdf-preview-preference.ts";

describe("PDF preview preference", () => {
  test("defaults to expanded and accepts the explicit collapsed mode", () => {
    expect(resolvePdfPreviewPreference(null)).toBe("expanded");
    expect(resolvePdfPreviewPreference("expanded")).toBe("expanded");
    expect(resolvePdfPreviewPreference("unexpected")).toBe("expanded");
    expect(resolvePdfPreviewPreference("collapsed")).toBe("collapsed");
  });
});
