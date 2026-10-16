import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { Problem, Settings } from "../shared/contracts.ts";

declare global {
  interface Window {
    __flyKeys: { code: string; trusted: boolean; time: number }[];
  }
}

export class BrowserComputer {
  browser?: Browser;
  context?: BrowserContext;
  page: Page | null = null;

  private currentPage() {
    if (!this.page) {
      throw new Error("Browser is not open");
    }

    return this.page;
  }

  async open() {
    if (this.page && !this.page.isClosed()) {
      return;
    }

    this.browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1200, height: 700 },
    });

    await this.context.addInitScript(() => {
      window.__flyKeys = [];

      document.addEventListener(
        "keydown",
        (event) => {
          window.__flyKeys.push({
            code: event.code,
            trusted: event.isTrusted,
            time: performance.now(),
          });

          if (window.__flyKeys.length > 256) {
            window.__flyKeys.shift();
          }
        },
        true,
      );
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);

    await this.page.goto("https://arithmetic.zetamac.com/", {
      waitUntil: "domcontentloaded",
    });
  }

  async startGame(
    settings: Settings,
    prepared: () => Promise<void> = async () => {},
  ) {
    await this.open();

    if (this.currentPage().url() !== "https://arithmetic.zetamac.com/") {
      await this.currentPage().goto("https://arithmetic.zetamac.com/", {
        waitUntil: "domcontentloaded",
      });
    }

    for (const operation of ["add", "sub", "mul", "div"] as const) {
      await this.currentPage()
        .locator(`[name=${operation}]`)
        .setChecked(settings[operation]);
    }

    for (const bank of ["add", "mul"] as const) {
      for (const side of ["left", "right"] as const) {
        for (const bound of ["min", "max"] as const) {
          const name = `${bank}_${side}_${bound}`;

          await this.currentPage()
            .locator(`[name=${name}]`)
            .fill(String(settings[name as keyof Settings]));
        }
      }
    }

    await this.currentPage()
      .locator("[name=duration]")
      .selectOption(String(settings.duration));

    await prepared();
    await this.currentPage().locator("input[type=submit]").click();
    await this.currentPage().waitForURL("**/game*");
    await this.currentPage().locator(".problem").waitFor();
    await this.currentPage().locator(".answer").focus();
  }

  async finished() {
    return this.currentPage().locator(".answer").isDisabled();
  }

  async waitForResults() {
    await this.currentPage()
      .locator(".banner .end")
      .waitFor({ state: "visible", timeout: 5000 });
  }

  async problem() {
    return parseProblem(
      await this.currentPage().locator(".problem").innerText(),
    );
  }

  async score() {
    const text = await this.currentPage()
      .locator("#game > .correct")
      .innerText();
    const match = text.match(/Score:\s*(\d+)/);

    if (!match) {
      throw new Error("Zetamac score could not be read");
    }

    return Number(match[1]);
  }

  async screenshot() {
    return (await this.currentPage().screenshot({ type: "png" })).toString(
      "base64",
    );
  }

  async close() {
    await this.browser?.close();
    this.page = null;
  }
}

export function parseProblem(text: string): Problem {
  const match = text.match(/^\s*(-?\d+)\s*([+−–×÷*/-])\s*(-?\d+)\s*$/);

  if (!match) {
    throw new Error("Unrecognised Zetamac problem");
  }

  const symbols: Record<string, string> = {
    "−": "-",
    "–": "-",
    "×": "*",
    "÷": "/",
  };
  const operation = (symbols[match[2]] ?? match[2]) as Problem["operation"];
  const a = Number(match[1]);
  const b = Number(match[3]);

  if (
    !Number.isSafeInteger(a) ||
    !Number.isSafeInteger(b) ||
    (operation === "/" && b === 0)
  ) {
    throw new Error("Unsupported Zetamac operands");
  }

  return { a, b, operation, text };
}
