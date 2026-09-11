import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AddressFields } from "../components/composer/addressFields";
import { SendBar } from "../components/composer/sendBar";
import { strings } from "../i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("address fields", () => {
  function AddressHarness({
    multipleSenders = true,
  }: {
    multipleSenders?: boolean;
  }) {
    const [fromAddress, setFromAddress] = useState("sam@example.test");
    const [to, setTo] = useState("");
    const [cc, setCc] = useState("");
    const [bcc, setBcc] = useState("");
    const [showCc, setShowCc] = useState(false);
    const [showBcc, setShowBcc] = useState(false);
    const [subject, setSubject] = useState("");
    const [recipientError, setRecipientError] = useState<string | undefined>(
      strings.composer.recipientRequired,
    );
    const [subjectError, setSubjectError] = useState<string | undefined>();
    return (
      <AddressFields
        accountId="account-1"
        availableSenders={
          multipleSenders
            ? [
                { email: "sam@example.test", label: "Sam" },
                { email: "alias@example.test", label: "Alias" },
              ]
            : [{ email: "sam@example.test", label: "Sam" }]
        }
        fromAddress={fromAddress}
        fromValue="Sam <sam@example.test>"
        setFromAddress={setFromAddress}
        to={to}
        setTo={setTo}
        cc={cc}
        setCc={setCc}
        bcc={bcc}
        setBcc={setBcc}
        showCc={showCc}
        setShowCc={setShowCc}
        showBcc={showBcc}
        setShowBcc={setShowBcc}
        subject={subject}
        setSubject={setSubject}
        recipientError={recipientError}
        setRecipientError={setRecipientError}
        subjectError={subjectError}
        setSubjectError={setSubjectError}
        markUnsaved={vi.fn()}
      />
    );
  }

  it("edits aliases, recipients, optional fields, and subject errors", () => {
    vi.spyOn(api, "suggestRecipients").mockResolvedValue([]);
    render(<AddressHarness />);
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.composer.fromAlias }),
      { target: { value: "alias@example.test" } },
    );
    fireEvent.click(screen.getByRole("button", { name: strings.composer.cc }));
    fireEvent.click(screen.getByRole("button", { name: strings.composer.bcc }));
    const to = document.getElementById("composer-to")!;
    const cc = document.getElementById("composer-cc")!;
    const bcc = document.getElementById("composer-bcc")!;
    fireEvent.change(cc, { target: { value: "copy@example.test" } });
    fireEvent.change(bcc, { target: { value: "blind@example.test" } });
    fireEvent.change(to, { target: { value: "jane@example.test" } });
    fireEvent.blur(to);
    fireEvent.blur(cc);
    fireEvent.blur(bcc);
    expect(
      screen.queryByText(strings.composer.recipientRequired),
    ).not.toBeInTheDocument();

    const subject = screen.getByRole("textbox", {
      name: strings.composer.subject,
    });
    fireEvent.change(subject, { target: { value: "bad\u007fsubject" } });
    fireEvent.blur(subject);
    expect(screen.getByRole("alert")).toHaveTextContent(
      strings.composer.invalidSubject,
    );
  });

  it("shows single sender as a read-only value", () => {
    render(<AddressHarness multipleSenders={false} />);
    expect(screen.getByDisplayValue("Sam <sam@example.test>")).toHaveAttribute(
      "readonly",
    );
  });
});

describe("send bar", () => {
  const sendMessage = vi.fn();
  const saveDraft = vi.fn();
  const addAttachments = vi.fn();
  const addInlineImage = vi.fn();
  const discardDraft = vi.fn();

  afterEach(() => {
    sendMessage.mockReset();
    saveDraft.mockReset();
    addAttachments.mockReset();
    addInlineImage.mockReset();
    discardDraft.mockReset();
  });

  function SendHarness() {
    const [sendMenuOpen, setSendMenuOpen] = useState(false);
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const [scheduleValue, setScheduleValue] = useState("");
    return (
      <SendBar
        sendMenuRef={{ current: null }}
        canSend
        sendMessage={sendMessage}
        sending={false}
        sendMenuOpen={sendMenuOpen}
        setSendMenuOpen={setSendMenuOpen}
        scheduleOpen={scheduleOpen}
        setScheduleOpen={setScheduleOpen}
        scheduleValue={scheduleValue}
        setScheduleValue={setScheduleValue}
        saveDraft={saveDraft}
        saveState="unsaved"
        addAttachments={addAttachments}
        addInlineImage={addInlineImage}
        discardDraft={discardDraft}
      />
    );
  }

  function openSendMenu() {
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.sendOptions }),
    );
  }

  it("sends now or later and dispatches draft actions", () => {
    render(<SendHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );

    openSendMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.sendNow }),
    );
    openSendMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.sendTonight }),
    );
    openSendMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.sendTomorrow }),
    );
    openSendMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.composer.sendCustom }),
    );
    const schedule = screen.getByLabelText(strings.composer.scheduleTime);
    fireEvent.change(schedule, { target: { value: "2026-09-15T10:30" } });
    fireEvent.submit(schedule.closest("form")!);

    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.saveDraft }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.attach }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.picture }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.discard }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(sendMessage.mock.calls[0]).toEqual([]);
    expect(sendMessage.mock.calls[1]).toEqual([]);
    expect(new Date(sendMessage.mock.calls[2][0]).getHours()).toBe(21);
    expect(new Date(sendMessage.mock.calls[3][0]).getHours()).toBe(8);
    expect(sendMessage.mock.calls[4][0]).toBe(
      new Date(2026, 8, 15, 10, 30).toISOString(),
    );
    expect(saveDraft).toHaveBeenCalledWith(false);
    expect(addAttachments).toHaveBeenCalled();
    expect(addInlineImage).toHaveBeenCalled();
    expect(discardDraft).toHaveBeenCalled();
  });

  it("disables unsafe actions while sending or saving", () => {
    const { rerender } = render(
      <SendBar
        sendMenuRef={{ current: null }}
        canSend={false}
        sendMessage={sendMessage}
        sending
        sendMenuOpen={false}
        setSendMenuOpen={vi.fn()}
        scheduleOpen={false}
        setScheduleOpen={vi.fn()}
        scheduleValue=""
        setScheduleValue={vi.fn()}
        saveDraft={saveDraft}
        saveState="saving"
        addAttachments={addAttachments}
        addInlineImage={addInlineImage}
        discardDraft={discardDraft}
      />,
    );
    expect(
      screen.getByRole("button", { name: strings.composer.sending }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: strings.common.saving }),
    ).toBeDisabled();
    rerender(
      <SendBar
        sendMenuRef={{ current: null }}
        canSend
        sendMessage={sendMessage}
        sending={false}
        sendMenuOpen
        setSendMenuOpen={vi.fn()}
        scheduleOpen
        setScheduleOpen={vi.fn()}
        scheduleValue=""
        setScheduleValue={vi.fn()}
        saveDraft={saveDraft}
        saveState="saved"
        addAttachments={addAttachments}
        addInlineImage={addInlineImage}
        discardDraft={discardDraft}
      />,
    );
    expect(
      screen.getByRole("button", { name: strings.composer.draftSaved }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: strings.composer.scheduleAction }),
    ).toBeDisabled();
  });
});
