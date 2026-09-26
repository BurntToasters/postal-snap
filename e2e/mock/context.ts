// Shared browser-side types for the mocked Tauri IPC layer used by e2e tests.
// Every mock module registers handlers against the same window-shared state:
// fixtures and the invoke dispatcher live on window.__POSTAL_SNAP_MOCK__,
// while the observable test bag lives on window.__POSTAL_SNAP_TEST__.

export type MockDistribution = "direct" | "store";

export interface MockAccount {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  syncState: string;
  error: string | null;
  signature?: string;
  aliases?: string[];
}

export interface MockMailbox {
  id: number;
  accountId: string;
  name: string;
  displayName: string;
  role: string;
  unreadCount: number;
  totalCount: number;
  delimiter?: string | null;
}

export interface MockMessageSummary {
  id: number;
  accountId: string;
  mailboxId: number;
  uid: number;
  messageId: string;
  subject: string;
  senderName: string;
  senderAddress: string;
  recipients: string;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
  threadRoot: string | null;
}

export interface MockState {
  windowCommands: string[];
  snapBounds: Array<Record<string, unknown>>;
  maximized: boolean;
  fullscreen: boolean;
  failWindowAction: boolean;
  savedSettings: unknown[];
  added: boolean;
  accountRemoved: boolean;
  releaseAddAccount?: () => void;
  accountLoads: number;
  discarded: boolean;
  snoozed: boolean;
  sentDraft: unknown;
  setupRequest: unknown;
  remoteFetches: number;
  openedUrls: string[];
  inlineReads: number;
  retried: boolean;
  moved: boolean;
  exportedSettings: number;
  importedSettings: number;
  printCalls: number;
  updateCalls: Array<{ command: string; args: Record<string, unknown> }>;
  backgroundUpdateAllowed: boolean;
  rules: Array<Record<string, unknown>>;
  callbacks: Map<number, (...args: unknown[]) => void>;
  eventListeners: Map<string, Set<number>>;
  nextCallback: number;
}

export type MockInvokeArgs = Record<string, unknown>;

export type MockInvokeHandler = (
  args: MockInvokeArgs,
) => unknown | Promise<unknown>;

export interface MockShared {
  account: MockAccount;
  accounts: MockAccount[];
  mailboxes: MockMailbox[];
  summary: MockMessageSummary;
  olderSummary: MockMessageSummary;
  secondSummary: MockMessageSummary;
  params: URLSearchParams;
  handlers: Record<string, MockInvokeHandler>;
}

declare global {
  interface Window {
    __POSTAL_SNAP_TEST__?: MockState;
    __POSTAL_SNAP_MOCK__?: MockShared;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: () => undefined;
    };
  }
}
