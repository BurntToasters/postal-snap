import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// AxeBuilder.analyze() can stall under parallel load in this environment; it
// opens a blank page via context.newPage(). Run axe in the page instead.
const AXE_SOURCE = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

export type AxeInPageViolation = {
  id: string;
  impact: string | null | undefined;
  nodes: { target: unknown }[];
};

export async function axeInPage(
  page: Page,
  include: string,
  options: { rules?: string[] } = {},
): Promise<AxeInPageViolation[]> {
  const loaded = await page.evaluate(
    () => (window as unknown as { axe?: unknown }).axe !== undefined,
  );
  if (!loaded) await page.evaluate(AXE_SOURCE);
  return page.evaluate(
    async ({ include, rules }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: Element,
              options: object,
            ) => Promise<{
              violations: {
                id: string;
                impact?: string | null;
                nodes: { target: unknown }[];
              }[];
            }>;
          };
        }
      ).axe;
      const context = document.querySelector(include);
      if (!context) throw new Error(`axe scope ${include} is not rendered`);
      const runOptions = rules
        ? { runOnly: { type: "rule", values: rules } }
        : {};
      const result = await axe.run(context, runOptions);
      return result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((node) => ({ target: node.target })),
      }));
    },
    { include, rules: options.rules },
  );
}
