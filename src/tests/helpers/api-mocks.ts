import { vi } from "vitest";
import { api } from "../../api";

export function mockSaveSettingsPassthrough(): void {
  vi.mocked(api.saveSettings).mockImplementation(async (s) => s);
}

export function mockNativeConfirmTrue(): void {
  vi.mocked(api.showNativeConfirm).mockResolvedValue(true);
}

export function mockApiSubset(): void {
  mockSaveSettingsPassthrough();
  mockNativeConfirmTrue();
}
