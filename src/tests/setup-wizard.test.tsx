import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupWizard } from "../components/SetupWizard";

describe("account setup", () => {
  it("starts with guided iCloud and secure manual choices", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    expect(screen.getByRole("button", { name: /iCloud Mail/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /Other email/i })).toBeVisible();
  });

  it("never offers plaintext transport", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    const securitySelectors = screen.getAllByLabelText("Security");
    for (const select of securitySelectors) {
      expect(select).toHaveTextContent("TLS");
      expect(select).toHaveTextContent("STARTTLS required");
      expect(select).not.toHaveTextContent(/none|plain/i);
    }
  });

  it("auto-completes @icloud.com domain when username is entered without domain", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /iCloud Mail/i }));
    const emailInput = screen.getByLabelText(
      /Email address/i,
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "johnappleseed" } });
    fireEvent.blur(emailInput);
    expect(emailInput.value).toBe("johnappleseed@icloud.com");
  });
});
