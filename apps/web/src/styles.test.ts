import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const stylesheet = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

afterEach(() => {
  document.querySelectorAll("[data-style-test]").forEach((element) => element.remove());
});

describe("secondary buttons on the dark balance card", () => {
  it.each([
    ["policy-balance-error", "button", "Recheck policy"],
    ["balance-actions", "a", "Receive"],
  ])("keeps %s controls readable", (containerClass, tagName, label) => {
    const style = document.createElement("style");
    style.dataset.styleTest = "";
    style.textContent = stylesheet;
    document.head.append(style);

    const card = document.createElement("div");
    card.dataset.styleTest = "";
    card.className = "balance-card";
    const container = document.createElement("div");
    container.className = containerClass;
    const button = document.createElement(tagName);
    button.className = "button secondary";
    button.textContent = label;
    container.append(button);
    card.append(container);
    document.body.append(card);

    const computed = getComputedStyle(button);
    expect(computed.color).toBe("rgb(233, 241, 247)");
    expect(computed.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(computed.borderTopColor).toBe("rgba(255, 255, 255, 0.3)");
  });
});
