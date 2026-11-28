import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

interface FileCoverage {
  path: string;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  statementMap: unknown;
  fnMap: unknown;
  branchMap: unknown;
  [key: string]: unknown;
}

type BrowserCoverage = Record<string, FileCoverage>;

interface CapturedDocument {
  id: string;
  coverage?: BrowserCoverage;
  counters?: CoverageCounters;
  signatures?: Record<string, string>;
}

interface FileCounters {
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

type CoverageCounters = Record<string, FileCounters>;

interface StoredDocument {
  counters?: CoverageCounters;
  serializedBytes: number;
}

interface CoverageInitOptions {
  expectedOrigin: string;
  storageKey: string;
  instrumentationSignaturesKey: string;
  errorKey: string;
  maxBytes: number;
  maxDocuments: number;
}

const MAX_DOCUMENTS_PER_TEST = 32;
const MAX_COVERAGE_BYTES_PER_TEST = 48 * 1024 * 1024;
const STORAGE_KEY = "__postal_snap_e2e_coverage_snapshots__";
const INSTRUMENTATION_SIGNATURES_KEY =
  "__postal_snap_e2e_coverage_map_signatures__";
const STORAGE_ERROR_KEY = "__postal_snap_e2e_coverage_error__";
const { createCoverageMap } = createRequire(import.meta.url)(
  "istanbul-lib-coverage",
) as {
  createCoverageMap: (coverage: BrowserCoverage) => {
    merge(coverage: BrowserCoverage): void;
    toJSON(): BrowserCoverage;
  };
};

function artifactId(
  projectId: string,
  workerIndex: number,
  testId: string,
  retry: number,
): string {
  return createHash("sha256")
    .update(`${projectId}:${workerIndex}:${testId}:${retry}`)
    .digest("hex")
    .slice(0, 20);
}

function outputDirectory(): string {
  return resolve(
    process.env.POSTAL_SNAP_E2E_COVERAGE_DIR ??
      resolve(import.meta.dirname, "../coverage/e2e"),
  );
}

function zeroFileCoverage(incoming: FileCoverage): FileCoverage {
  return {
    ...incoming,
    s: Object.fromEntries(Object.keys(incoming.s).map((id) => [id, 0])),
    f: Object.fromEntries(Object.keys(incoming.f).map((id) => [id, 0])),
    b: Object.fromEntries(
      Object.entries(incoming.b).map(([id, counts]) => [
        id,
        counts.map(() => 0),
      ]),
    ),
  };
}

function countersFromCoverage(snapshot: BrowserCoverage): CoverageCounters {
  return Object.fromEntries(
    Object.entries(snapshot).map(([file, coverage]) => [
      file,
      {
        s: { ...coverage.s },
        f: { ...coverage.f },
        b: Object.fromEntries(
          Object.entries(coverage.b).map(([id, counts]) => [id, [...counts]]),
        ),
      },
    ]),
  );
}

function instrumentationSignature(coverage: FileCoverage): string {
  if (typeof coverage.hash === "string" && coverage.hash.length > 0) {
    return `hash:${coverage.hash}`;
  }
  return `maps:${JSON.stringify([
    coverage.statementMap,
    coverage.fnMap,
    coverage.branchMap,
  ])}`;
}

function mergeCoverage(
  templates: BrowserCoverage,
  documents: Iterable<StoredDocument>,
): BrowserCoverage {
  const merged = createCoverageMap(templates);
  for (const document of documents) {
    if (!document.counters) continue;
    merged.merge(
      Object.fromEntries(
        Object.entries(document.counters).map(([file, counters]) => [
          file,
          { ...templates[file], ...counters },
        ]),
      ),
    );
  }
  return merged.toJSON();
}

async function captureDocument(
  page: Page,
  appOrigin: string,
): Promise<CapturedDocument | null> {
  return page.evaluate((expectedOrigin) => {
    if (location.href === "about:blank" || location.origin !== expectedOrigin) {
      return null;
    }
    const browser = window as typeof window & {
      __coverage__?: BrowserCoverage;
      __postalSnapCoverageDocumentId?: string;
    };
    browser.__postalSnapCoverageDocumentId ??= crypto.randomUUID();
    return {
      id: browser.__postalSnapCoverageDocumentId,
      coverage: browser.__coverage__,
    };
  }, appOrigin);
}

export const test = base.extend({
  page: async ({ page, context }, use, testInfo) => {
    if (process.env.E2E_COVERAGE !== "true") {
      await use(page);
      return;
    }

    const configuredBaseUrl = testInfo.project.use.baseURL;
    const appOrigin =
      typeof configuredBaseUrl === "string"
        ? new URL(configuredBaseUrl).origin
        : undefined;
    if (!appOrigin) {
      throw new Error("E2E coverage needs a configured app baseURL.");
    }

    const documents = new Map<string, StoredDocument>();
    const missingInstrumentationIds = new Set<string>();
    const coverageTemplates: BrowserCoverage = {};
    const instrumentationSignatures = new Map<string, string>();
    let retainedDocumentCounterBytes = 0;
    let retainedDocumentIdBytes = 0;
    let retainedSignatureBytes = 0;
    let coverageTemplateBytes = 0;
    let captureFailure: string | undefined;
    let closeCaptured = false;
    let pendingCollection = Promise.resolve();
    let lastDocumentId: string | undefined;

    const storeCapturedDocument = (captured: CapturedDocument): void => {
      if (captureFailure) return;

      const previous = documents.get(captured.id);
      if (!previous && documents.size >= MAX_DOCUMENTS_PER_TEST) {
        captureFailure = `E2E coverage exceeded ${MAX_DOCUMENTS_PER_TEST} documents in one test.`;
        return;
      }

      const counters =
        captured.counters ??
        (captured.coverage
          ? countersFromCoverage(captured.coverage)
          : undefined);
      const signatures =
        captured.signatures ??
        (captured.coverage
          ? Object.fromEntries(
              Object.entries(captured.coverage).map(([file, coverage]) => [
                file,
                instrumentationSignature(coverage),
              ]),
            )
          : undefined);
      const serializedBytes = counters
        ? Buffer.byteLength(JSON.stringify(counters))
        : 0;
      const nextDocumentCounterBytes =
        retainedDocumentCounterBytes -
        (previous?.serializedBytes ?? 0) +
        serializedBytes;
      const newDocumentIdBytes = previous ? 0 : Buffer.byteLength(captured.id);
      const nextDocumentIdBytes = retainedDocumentIdBytes + newDocumentIdBytes;
      const pendingMetadata: Array<[string, FileCoverage]> = [];
      const pendingSignatures: Array<[string, string]> = [];
      const pendingMetadataFiles = new Set<string>();
      let addedMetadataBytes = 0;
      let addedSignatureBytes = 0;

      if (captured.coverage) {
        for (const [file, incoming] of Object.entries(captured.coverage)) {
          const signature = signatures?.[file];
          if (!signature || signature !== instrumentationSignature(incoming)) {
            throw new Error(
              "E2E coverage instrumentation signature is missing.",
            );
          }
          const existingSignature = instrumentationSignatures.get(file);
          if (existingSignature && existingSignature !== signature) {
            throw new Error(
              "E2E coverage instrumentation changed between documents.",
            );
          }
          if (!existingSignature) {
            pendingSignatures.push([file, signature]);
            addedSignatureBytes +=
              Buffer.byteLength(file) + Buffer.byteLength(signature);
          }
          if (!coverageTemplates[file]) {
            const empty = zeroFileCoverage(incoming);
            pendingMetadata.push([file, empty]);
            pendingMetadataFiles.add(file);
            addedMetadataBytes += Buffer.byteLength(
              JSON.stringify({ [file]: empty }),
            );
          }
        }
      }

      if (counters) {
        const counterFiles = Object.keys(counters).sort();
        const signatureFiles = Object.keys(signatures ?? {}).sort();
        if (JSON.stringify(counterFiles) !== JSON.stringify(signatureFiles)) {
          throw new Error("E2E coverage file map changed between documents.");
        }
        for (const file of counterFiles) {
          const signature = signatures?.[file];
          const existingSignature = instrumentationSignatures.get(file);
          const hasNewMetadata = pendingMetadataFiles.has(file);
          if (!signature || (!existingSignature && !hasNewMetadata)) {
            throw new Error("E2E coverage instrumentation map is missing.");
          }
          if (existingSignature && existingSignature !== signature) {
            throw new Error(
              "E2E coverage instrumentation changed between documents.",
            );
          }
          if (!coverageTemplates[file] && !hasNewMetadata) {
            throw new Error("E2E coverage file map changed between documents.");
          }
        }
      }

      if (
        coverageTemplateBytes +
          addedMetadataBytes +
          2 * nextDocumentCounterBytes +
          nextDocumentIdBytes +
          retainedSignatureBytes +
          addedSignatureBytes >
        MAX_COVERAGE_BYTES_PER_TEST
      ) {
        captureFailure =
          "E2E coverage exceeded the per-test snapshot size limit.";
        return;
      }

      for (const [file, signature] of pendingSignatures) {
        instrumentationSignatures.set(file, signature);
      }
      for (const [file, metadata] of pendingMetadata) {
        coverageTemplates[file] = metadata;
      }
      retainedSignatureBytes += addedSignatureBytes;
      coverageTemplateBytes += addedMetadataBytes;

      if (!counters) missingInstrumentationIds.add(captured.id);
      documents.set(captured.id, { counters, serializedBytes });
      retainedDocumentCounterBytes = nextDocumentCounterBytes;
      retainedDocumentIdBytes = nextDocumentIdBytes;
    };

    const saveCurrentDocument = async (): Promise<void> => {
      if (page.isClosed()) return;
      let captured: CapturedDocument | null;
      try {
        captured = await captureDocument(page, appOrigin);
      } catch {
        captureFailure = "A document could not be captured before navigation.";
        return;
      }
      if (captured) storeCapturedDocument(captured);
    };

    const collectStoredDocuments = async (): Promise<string[]> => {
      if (page.isClosed()) return [];
      try {
        const stored = await page.evaluate((expectedOrigin) => {
          if (location.origin !== expectedOrigin) return null;
          const snapshots = sessionStorage.getItem(
            "__postal_snap_e2e_coverage_snapshots__",
          );
          const error = sessionStorage.getItem(
            "__postal_snap_e2e_coverage_error__",
          );
          sessionStorage.removeItem("__postal_snap_e2e_coverage_snapshots__");
          sessionStorage.removeItem("__postal_snap_e2e_coverage_error__");
          return {
            snapshots: snapshots
              ? (JSON.parse(snapshots) as CapturedDocument[])
              : [],
            error: error === "1",
          };
        }, appOrigin);
        if (!stored) return [];
        if (stored.error) {
          captureFailure =
            "An app document exceeded the coverage storage limit.";
        }
        for (const captured of stored.snapshots) {
          storeCapturedDocument(captured);
        }
        return stored.snapshots.map((snapshot) => snapshot.id);
      } catch {
        captureFailure = "A previous app document could not be collected.";
        return [];
      }
    };

    const currentDocumentId = async (): Promise<string | undefined> => {
      if (page.isClosed()) return undefined;
      try {
        return await page.evaluate((expectedOrigin) => {
          if (location.origin !== expectedOrigin) return undefined;
          const browser = window as typeof window & {
            __postalSnapCoverageDocumentId?: string;
          };
          browser.__postalSnapCoverageDocumentId ??= crypto.randomUUID();
          return browser.__postalSnapCoverageDocumentId;
        }, appOrigin);
      } catch {
        captureFailure = "An app document ID could not be read.";
        return undefined;
      }
    };

    await page.addInitScript(
      (options: CoverageInitOptions) => {
        const {
          expectedOrigin,
          storageKey,
          instrumentationSignaturesKey,
          errorKey,
          maxBytes,
          maxDocuments,
        } = options;
        if (window !== window.top || location.origin !== expectedOrigin) return;
        const browser = window as typeof window & {
          __coverage__?: BrowserCoverage;
          __postalSnapCoverageDocumentId?: string;
        };
        browser.__postalSnapCoverageDocumentId ??= crypto.randomUUID();
        window.addEventListener("pagehide", () => {
          const current = window as typeof window & {
            __coverage__?: BrowserCoverage;
            __postalSnapCoverageDocumentId?: string;
          };
          const coverage = current.__coverage__;
          const previousSignatures = sessionStorage.getItem(
            instrumentationSignaturesKey,
          );
          const sentSignatures = previousSignatures
            ? (JSON.parse(previousSignatures) as Record<string, string>)
            : {};
          const signatures = coverage
            ? Object.fromEntries(
                Object.entries(coverage).map(([file, entry]) => [
                  file,
                  typeof entry.hash === "string" && entry.hash.length > 0
                    ? `hash:${entry.hash}`
                    : `maps:${JSON.stringify([
                        entry.statementMap,
                        entry.fnMap,
                        entry.branchMap,
                      ])}`,
                ]),
              )
            : undefined;
          const newCoverage =
            coverage && signatures
              ? Object.fromEntries(
                  Object.entries(coverage).filter(
                    ([file]) => sentSignatures[file] !== signatures[file],
                  ),
                )
              : undefined;
          const snapshot = {
            id: current.__postalSnapCoverageDocumentId ?? crypto.randomUUID(),
            coverage:
              newCoverage && Object.keys(newCoverage).length > 0
                ? newCoverage
                : undefined,
            counters: coverage
              ? Object.fromEntries(
                  Object.entries(coverage).map(([file, entry]) => [
                    file,
                    { s: entry.s, f: entry.f, b: entry.b },
                  ]),
                )
              : undefined,
            signatures,
          };
          try {
            const previous = sessionStorage.getItem(storageKey);
            const snapshots = previous ? JSON.parse(previous) : [];
            if (snapshots.length >= maxDocuments) {
              sessionStorage.setItem(errorKey, "1");
              return;
            }
            snapshots.push(snapshot);
            const serialized = JSON.stringify(snapshots);
            if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
              sessionStorage.setItem(errorKey, "1");
              return;
            }
            sessionStorage.setItem(storageKey, serialized);
            if (signatures) {
              sessionStorage.setItem(
                instrumentationSignaturesKey,
                JSON.stringify({ ...sentSignatures, ...signatures }),
              );
            }
          } catch {
            try {
              sessionStorage.setItem(errorKey, "1");
            } catch {
              // The next capture or explicit close will fail closed if storage is full.
            }
          }
        });
      },
      {
        expectedOrigin: appOrigin,
        storageKey: STORAGE_KEY,
        instrumentationSignaturesKey: INSTRUMENTATION_SIGNATURES_KEY,
        errorKey: STORAGE_ERROR_KEY,
        maxBytes: MAX_COVERAGE_BYTES_PER_TEST,
        maxDocuments: MAX_DOCUMENTS_PER_TEST,
      },
    );
    page.on("framenavigated", (frame) => {
      if (
        frame === page.mainFrame() &&
        frame.url() !== "about:blank" &&
        new URL(frame.url()).origin === appOrigin
      ) {
        pendingCollection = pendingCollection.then(async () => {
          const previousId = lastDocumentId;
          const capturedIds = await collectStoredDocuments();
          const nextId = await currentDocumentId();
          if (
            previousId &&
            nextId !== previousId &&
            !capturedIds.includes(previousId)
          ) {
            captureFailure =
              "An app document navigated away without a coverage snapshot.";
          }
          lastDocumentId = nextId;
        });
      }
    });

    const originalClose = context.close.bind(context);
    Object.defineProperty(context, "close", {
      configurable: true,
      value: async (options?: { reason?: string }) => {
        await pendingCollection;
        await collectStoredDocuments();
        await saveCurrentDocument();
        closeCaptured = true;
        await originalClose(options);
      },
    });
    const originalPageClose = page.close.bind(page);
    Object.defineProperty(page, "close", {
      configurable: true,
      value: async (options?: Parameters<Page["close"]>[0]) => {
        await pendingCollection;
        await collectStoredDocuments();
        await saveCurrentDocument();
        closeCaptured = true;
        await originalPageClose(options);
      },
    });
    page.on("close", () => {
      if (!closeCaptured) {
        captureFailure =
          "An app page closed before its final coverage snapshot.";
      }
    });

    await use(page);
    await pendingCollection;
    await collectStoredDocuments();
    if (!page.isClosed()) await saveCurrentDocument();

    if (captureFailure) throw new Error(captureFailure);
    const missingInstrumentation = missingInstrumentationIds.size;
    if (missingInstrumentation > 0) {
      throw new Error(
        `E2E coverage was requested, but ${missingInstrumentation} app document(s) were not instrumented.`,
      );
    }
    if (documents.size === 0) return;

    const serializedCoverage = `${JSON.stringify(
      mergeCoverage(coverageTemplates, documents.values()),
    )}\n`;
    if (Buffer.byteLength(serializedCoverage) > MAX_COVERAGE_BYTES_PER_TEST) {
      throw new Error("Merged E2E coverage exceeded the per-test size limit.");
    }

    const directory = outputDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(
        directory,
        `${artifactId(testInfo.project.name, testInfo.workerIndex, testInfo.testId, testInfo.retry)}.json`,
      ),
      serializedCoverage,
    );
  },
});

export { expect };
