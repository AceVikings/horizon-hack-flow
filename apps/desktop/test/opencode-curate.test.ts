import { describe, expect, it } from "vitest";
import { curate } from "../src/renderer/views/setup/Opencode";

describe("OpenCode model shortlist", () => {
  it("recommended first, then one best model per family, at most 6", () => {
    const all = ["a/x", "opencode/glm-5.3-flash", "opencode/deepseek-v4.1-flash", "anthropic/claude-opus-4-8", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-5.2", "openai/gpt-5-mini", "google/gemini-3-pro", ...Array.from({ length: 500 }, (_, i) => `z/m${i}`)];
    const c = curate(all);
    expect(c.slice(0, 2)).toEqual(["opencode/deepseek-v4.1-flash", "opencode/glm-5.3-flash"]);
    expect(c).toContain("anthropic/claude-opus-5-5");
    expect(c).not.toContain("openai/gpt-5-mini");
    expect(c.length).toBeLessThanOrEqual(6);
  });
});
