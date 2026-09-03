import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SetupWizard } from "../components/SetupWizard";
import { PostalError } from "../errors";

vi.mock("../api", () => ({
  api: {
    addAccount: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const addAccount = vi.mocked(api.addAccount);

function fillIcloudForm() {
  fireEvent.click(screen.getByRole("button", { name: /iCloud Mail/i }));
  fireEvent.change(screen.getByLabelText(/Your name/i), {
    target: { value: "Sam" },
  });
  fireEvent.change(screen.getByLabelText(/Email address/i), {
    target: { value: "sam@icloud.com" },
  });
  fireEvent.change(screen.getByLabelText(/App-specific password/i), {
    target: { value: "abcd efgh ijkl mnop" },
  });
}

describe("account setup", () => {
  beforeEach(() => {
    addAccount.mockReset();
    addAccount.mockResolvedValue({
      id: "account-1",
      provider: "icloud",
      email: "sam@icloud.com",
      displayName: "Sam",
      syncState: "idle",
      error: null,
    });
  });

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

  it("shows iCloud IMAP and SMTP defaults without exposing editable servers", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /iCloud Mail/i }));
    expect(screen.getByText("imap.mail.me.com · 993 · TLS")).toBeVisible();
    expect(
      screen.getByText("smtp.mail.me.com · 587 · STARTTLS required"),
    ).toBeVisible();
    expect(screen.queryByLabelText("Server")).toBeNull();
  });

  it("starts the other-provider path with empty hosts, not iCloud servers", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    const hosts = screen.getAllByLabelText("Server") as HTMLInputElement[];
    expect(hosts[0].value).toBe("");
    expect(hosts[1].value).toBe("");
    expect(screen.queryByText(/imap\.mail\.me\.com/)).toBeNull();
    const ports = screen.getAllByLabelText("Port") as HTMLInputElement[];
    expect(ports[0].value).toBe("993");
    expect(ports[1].value).toBe("587");
  });

  it("copies the email address into IMAP and SMTP usernames", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: "sam@example.com" },
    });
    const usernames = screen.getAllByLabelText(
      "Username",
    ) as HTMLInputElement[];
    expect(usernames[0].value).toBe("sam@example.com");
    expect(usernames[1].value).toBe("sam@example.com");
  });

  it("updates the matching default port when TLS mode changes", () => {
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    const security = screen.getAllByLabelText("Security");
    fireEvent.change(security[0], { target: { value: "startTls" } });
    const ports = screen.getAllByLabelText("Port") as HTMLInputElement[];
    expect(ports[0].value).toBe("143");
    fireEvent.change(security[1], { target: { value: "tls" } });
    expect(ports[1].value).toBe("465");
  });

  it("submits iCloud without manual server settings and strips password spaces", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<SetupWizard onComplete={onComplete} />);
    fillIcloudForm();
    fireEvent.click(screen.getByRole("button", { name: /Connect securely/i }));
    await waitFor(() => expect(addAccount).toHaveBeenCalled());
    expect(addAccount).toHaveBeenCalledWith({
      provider: "icloud",
      displayName: "Sam",
      email: "sam@icloud.com",
      password: "abcdefghijklmnop",
      imap: undefined,
      smtp: undefined,
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("submits the other-provider path with the entered IMAP and SMTP settings", async () => {
    addAccount.mockResolvedValue({
      id: "account-2",
      provider: "manual",
      email: "sam@example.com",
      displayName: "Sam",
      syncState: "idle",
      error: null,
    });
    render(<SetupWizard onComplete={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    fireEvent.change(screen.getByLabelText(/Your name/i), {
      target: { value: "Sam" },
    });
    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: "sam@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Email password/i), {
      target: { value: "secret" },
    });
    const hosts = screen.getAllByLabelText("Server");
    fireEvent.change(hosts[0], { target: { value: "imap.example.com" } });
    fireEvent.change(hosts[1], { target: { value: "smtp.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect securely/i }));
    await waitFor(() => expect(addAccount).toHaveBeenCalled());
    expect(addAccount).toHaveBeenCalledWith({
      provider: "manual",
      displayName: "Sam",
      email: "sam@example.com",
      password: "secret",
      imap: {
        host: "imap.example.com",
        port: 993,
        tlsMode: "tls",
        username: "sam@example.com",
      },
      smtp: {
        host: "smtp.example.com",
        port: 587,
        tlsMode: "startTls",
        username: "sam@example.com",
      },
    });
  });

  it("keeps iCloud credentials and explains how to recover from a sign-in failure", async () => {
    addAccount.mockRejectedValueOnce(
      new PostalError({
        code: "authenticationFailed",
        message: "Sign-in failed. Check the email address and password.",
        retryable: true,
      }),
    );
    render(<SetupWizard onComplete={vi.fn()} />);
    fillIcloudForm();
    fireEvent.click(screen.getByRole("button", { name: /Connect securely/i }));
    expect(
      await screen.findByText(/regular Apple Account password will not work/i),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /Create app-specific password/i })
        .length,
    ).toBeGreaterThan(0);
    expect(
      (screen.getByLabelText(/App-specific password/i) as HTMLInputElement)
        .value,
    ).toMatch(/abcd/);
  });

  it("explains manual sign-in failures without iCloud password instructions", async () => {
    addAccount.mockRejectedValueOnce(
      new PostalError({
        code: "authenticationFailed",
        message: "Sign-in failed. Check the email address and password.",
        retryable: true,
      }),
    );
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Other email/i }));
    fireEvent.change(screen.getByLabelText(/Your name/i), {
      target: { value: "Sam" },
    });
    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: "sam@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Email password/i), {
      target: { value: "secret" },
    });
    const hosts = screen.getAllByLabelText("Server");
    fireEvent.change(hosts[0], { target: { value: "imap.example.com" } });
    fireEvent.change(hosts[1], { target: { value: "smtp.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect securely/i }));
    expect(
      await screen.findByText(/Usernames are often the full email address/i),
    ).toBeVisible();
    expect(screen.queryByText(/regular Apple Account password/i)).toBeNull();
  });

  it("announces sign-in failures as alerts and links iCloud hints", async () => {
    addAccount.mockRejectedValueOnce(
      new PostalError({
        code: "authenticationFailed",
        message: "Sign-in failed. Check the email address and password.",
        retryable: true,
      }),
    );
    render(<SetupWizard onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /iCloud Mail/i }));
    expect(screen.getByText(/me\.com.*mac\.com/i)).toBeDefined();
    const emailInput = screen.getByLabelText(/Email address/i);
    expect(emailInput.getAttribute("aria-describedby")).toBe(
      "setup-email-hint",
    );
    const passwordInput = screen.getByLabelText(/App-specific password/i);
    expect(passwordInput.getAttribute("aria-describedby")).toBe(
      "setup-password-hint",
    );
    fireEvent.change(screen.getByLabelText(/Your name/i), {
      target: { value: "Sam" },
    });
    fireEvent.change(emailInput, { target: { value: "sam@icloud.com" } });
    fireEvent.change(passwordInput, {
      target: { value: "abcd efgh ijkl mnop" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect securely/i }));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
