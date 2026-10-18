import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, login, state } from "./helpers";

test.describe.configure({ mode: "serial" });

const acme = () => state().acme.orgId;
const ORIGIN = "http://localhost:3100";
const english = (page: Page) => page.context().addCookies([{ name: "tt_locale", value: "en", url: ORIGIN }]);

test.describe("language", () => {
  test("Thai is the default, English can be chosen, and the choice survives a reload", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "th");
    await expect(page.getByRole("heading", { name: "เข้าสู่ระบบ", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "ภาษา" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  });

  test("signed-in language is stored on the profile, translates statuses, and dates use the Buddhist Era", async ({ page }) => {
    await english(page);
    await login(page, "admin@e2e.test");
    try {
      await page.goto(`/o/${acme()}/my-tasks`);
      await page.getByRole("button", { name: "Language" }).click(); // shows "ไทย"
      await expect(page.getByRole("link", { name: "งานของฉัน" })).toBeVisible();
      await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { locale: string }).locale).toBe("th");
      await page.reload();
      await expect(page.getByRole("heading", { name: "งานของฉัน", level: 1 })).toBeVisible();

      await page.goto(`/o/${acme()}/tasks?view=board`);
      await expect(page.getByRole("listitem", { name: "รอดำเนินการ" })).toBeVisible();
      await expect(page.getByRole("listitem", { name: "To do" })).toHaveCount(0);

      await page.goto(`/o/${acme()}/tasks?view=calendar`);
      const me = (await (await page.request.get("/api/me")).json()) as { timezone: string };
      const gregorian = Number(new Intl.DateTimeFormat("en-CA", { timeZone: me.timezone, year: "numeric" }).format(new Date()));
      await expect(page.getByRole("heading", { level: 2 }).filter({ hasText: String(gregorian + 543) })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2 }).filter({ hasText: String(gregorian) })).toHaveCount(0);
    } finally {
      await page.request.patch("/api/me", { data: { locale: "en" }, headers: { origin: ORIGIN } }); // leave the shared account as we found it
    }
  });
});

const ORG_PAGES: [string, string][] = [
  ["my tasks", "/my-tasks"],
  ["task list", "/tasks"],
  ["board", "/tasks?view=board"],
  ["calendar", "/tasks?view=calendar"],
  ["timeline", "/tasks?view=timeline"],
  ["dashboard", "/dashboard"],
  ["recurring tasks", "/recurring"],
  ["members", "/members"],
  ["structure", "/structure"],
  ["settings", "/settings"],
  ["audit log", "/audit"],
  ["search", "/search?q=Sprint"],
];

async function settled(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).or(page.getByRole("heading", { level: 2 })).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test.describe("responsive layout (375 x 667 phone)", () => {
  test.use({ viewport: { width: 375, height: 667 } });
  test.beforeEach(async ({ page }) => { await english(page); });

  const noHorizontalScroll = async (page: Page, label: string) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${label} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
  };

  test("public pages fit the screen", async ({ page }) => {
    for (const path of ["/login", "/register", "/forgot-password"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noHorizontalScroll(page, path);
    }
  });

  test("every organization page fits the screen, with the menu behind a button", async ({ page }) => {
    await login(page, "admin@e2e.test");
    for (const [label, path] of ORG_PAGES) {
      await page.goto(`/o/${acme()}${path}`);
      await settled(page);
      await noHorizontalScroll(page, label);
    }
  });

  test("the navigation opens from the menu button, is unreachable by keyboard while closed, and closes after use", async ({ page }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/my-tasks`);
    const toggle = page.getByRole("button", { name: "Toggle menu" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeHidden();
  });

  test("a task opens full-width and can be closed", async ({ page }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/tasks`);
    await page.getByRole("button", { name: "Design the homepage", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Design the homepage", level: 2 })).toBeVisible();
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375 + 1);
    // flush with the top of the window, and the backdrop covers the whole window (a spacing rule once pushed both down by 14 px)
    expect(box.y).toBe(0);
    expect((await page.locator(".drawer-scrim").boundingBox())!.y).toBe(0);
    await noHorizontalScroll(page, "task drawer");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("accessibility (axe, WCAG 2.0/2.1 A and AA)", () => {
  test.beforeEach(async ({ page }) => { await english(page); });

  test("public pages", async ({ page }) => {
    for (const path of ["/login", "/register", "/forgot-password", "/join"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectAccessible(page, path);
    }
  });

  test("signed-in pages in the light theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await login(page, "admin@e2e.test");
    for (const path of ["/", "/security"]) {
      await page.goto(path);
      await settled(page);
      await expectAccessible(page, path);
    }
    for (const [label, path] of ORG_PAGES) {
      await page.goto(`/o/${acme()}${path}`);
      await settled(page);
      await expectAccessible(page, label);
    }
  });

  test("signed-in pages in the dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, "admin@e2e.test");
    for (const [label, path] of ORG_PAGES) {
      await page.goto(`/o/${acme()}${path}`);
      await settled(page);
      await expectAccessible(page, `${label} (dark)`);
    }
  });

  test("dialogs and the task drawer", async ({ page }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/tasks`);
    await page.getByRole("button", { name: /New task/ }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await expectAccessible(page, "new task dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: "Save view" }).click();
    await expect(page.getByRole("dialog", { name: "Save view" })).toBeVisible();
    await expectAccessible(page, "save view dialog");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Design the homepage", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Design the homepage", level: 2 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectAccessible(page, "task drawer");
    await page.keyboard.press("Escape");

    await page.goto(`/o/${acme()}/recurring`);
    await page.getByRole("button", { name: /New recurring task/ }).click();
    await expect(page.getByRole("dialog", { name: "New recurring task" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectAccessible(page, "new recurring task dialog");
  });

  test("keyboard: the dialog traps focus, Escape closes it and focus returns to where it was", async ({ page }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/tasks`);
    const opener = page.getByRole("button", { name: /New task/ });
    await expect(opener).toBeEnabled(); // disabled until the project list has loaded
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `focus escaped the dialog on Tab #${i + 1}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("the skip link is the first tab stop and moves focus to the content", async ({ page }) => {
    await login(page, "admin@e2e.test");
    await page.goto(`/o/${acme()}/dashboard`);
    await settled(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });
});
