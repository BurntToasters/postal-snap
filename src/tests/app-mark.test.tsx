import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppMark } from "../components/AppMark";

describe("AppMark", () => {
  it("uses the bundled app icon instead of the envelope drawing", () => {
    const { container } = render(<AppMark size={52} />);
    const image = container.querySelector("img.app-mark");
    expect(image).toBeVisible();
    expect(image).toHaveAttribute("width", "52");
    expect(image).toHaveAttribute("height", "52");
    expect(image?.getAttribute("src") ?? "").toMatch(/icon\.png/);
    expect(container.querySelector("svg")).toBeNull();
  });
});
