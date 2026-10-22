import { test, expect, devices } from "@playwright/test";

const group = (page, label = "输入四位猜测数字") =>
  page.getByRole("group", { name: label, exact: true });
async function enterCode(page, code, label) {
  await group(page, label).locator("input").first().click();
  await page.keyboard.type(code);
}
async function values(page, label) {
  return group(page, label)
    .locator("input")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
}
async function assertSingleScreen(page) {
  const geometry = await page.evaluate(() => {
    const left = document.querySelector(".input-panel").getBoundingClientRect();
    const right = document
      .querySelector(".history-panel")
      .getBoundingClientRect();
    const dial = document.querySelector(".number-dial").getBoundingClientRect();
    const keypad = document.querySelector(".keypad")?.getBoundingClientRect();
    const visible = [
      ...document.querySelectorAll(
        ".digit-entry, .keypad, .number-dial, .record-sheets, .history-table tbody tr, .input-heading, .game-clock, .outcome-banner, .outcome-copy h2, .result-code, .result-action",
      ),
    ].every((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.bottom <= innerHeight + 1
      );
    });
    return {
      width: document.documentElement.scrollWidth <= innerWidth,
      height: document.documentElement.scrollHeight <= innerHeight,
      correctLayout:
        document.documentElement.dataset.device === "mobile" &&
        innerHeight > innerWidth
          ? right.bottom <= dial.top + 1 &&
            dial.bottom <= left.top + 1 &&
            (!keypad || keypad.top >= left.top - 1)
          : right.left >= left.right - 1,
      visible,
      titleCorrect:
        document.documentElement.dataset.device === "mobile"
          ? getComputedStyle(document.querySelector("h1")).display === "none"
          : document.querySelector("h1").textContent === "数字炸弹",
    };
  });
  expect(geometry).toEqual({
    width: true,
    height: true,
    correctLayout: true,
    visible: true,
    titleCorrect: true,
  });
}

async function assertLatestAtBottom(page) {
  await expect
    .poll(() =>
      page
        .locator(".newest")
        .evaluate((row) =>
          Math.abs(
            row.getBoundingClientRect().bottom -
              row.closest("tbody").getBoundingClientRect().bottom,
          ),
        ),
    )
    .toBeLessThanOrEqual(2);
}

test("单机：右侧三列记录、刷新恢复、揭晓和重新开始", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await enterCode(page, "0012");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator("tr[data-guess]")).toHaveCount(1);
  await expect(page.locator("tr[data-guess] td")).toHaveCount(3);
  await expect(page.locator(".guess-number")).toHaveText("0012");
  await assertLatestAtBottom(page);
  await assertSingleScreen(page);
  await page.reload();
  await expect(page.locator(".guess-number")).toHaveText("0012");
  if (
    await page
      .getByRole("heading", { name: "挑战成功！", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "再来一局" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "揭晓答案" }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.locator(".result-digit")).toHaveCount(4);
  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.locator("tr[data-guess]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("逐位输入、替换、删除和左右键切换，不移动其他数字", async ({ page }) => {
  await page.goto("/");
  await enterCode(page, "0123");
  const inputs = group(page).locator("input");
  await inputs.nth(0).click();
  await page
    .locator(".keypad")
    .getByRole("button", { name: "9", exact: true })
    .click();
  expect(await values(page)).toEqual(["9", "1", "2", "3"]);
  await inputs.nth(1).click();
  await page.getByRole("button", { name: "删除选中位" }).click();
  expect(await values(page)).toEqual(["9", "", "2", "3"]);
  await expect(
    page.getByRole("button", { name: "猜一下", exact: true }),
  ).toBeDisabled();
  await page
    .locator(".keypad")
    .getByRole("button", { name: "0", exact: true })
    .click();
  expect(await values(page)).toEqual(["9", "0", "2", "3"]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Delete");
  expect(await values(page)).toEqual(["9", "0", "2", ""]);
  await page.keyboard.type("4");
  await inputs.nth(0).fill("０");
  expect(await values(page)).toEqual(["0", "0", "2", "4"]);
  await page.keyboard.press("Enter");
  await expect(page.locator(".guess-number")).toHaveText("0024");
});

test("右键固定、保留到下次猜测、解除固定，排除表盘和刷新恢复", async ({
  page,
}) => {
  await page.goto("/");
  await enterCode(page, "0012");
  const first = group(page).locator("input").nth(0);
  await first.click({ button: "right" });
  await expect(first).toHaveAttribute("data-pinned", "true");
  await group(page).locator("input").nth(2).click({ button: "right" });
  await first.click();
  await page.keyboard.type("9");
  expect((await values(page))[0]).toBe("0");
  const excluded = page.getByRole("button", { name: "标记数字7为排除" });
  await excluded.click();
  await expect(excluded).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0012");
  // The secret is random; a first-guess win still verifies the pin before
  // submitting, but a new guess is only possible while this round is active.
  if (await group(page).isVisible()) {
    expect(await values(page)).toEqual(["0", "", "1", ""]);
    await page.reload();
    await expect(group(page).locator("input").first()).toHaveValue("0");
    await expect(group(page).locator("input").nth(2)).toHaveValue("1");
    await expect(excluded).toHaveAttribute("aria-pressed", "true");
    await group(page).locator("input").nth(1).click();
    await page.keyboard.type("34");
    expect(await values(page)).toEqual(["0", "3", "1", "4"]);
    await group(page).locator("input").first().click({ button: "right" });
    await expect(group(page).locator("input").first()).toHaveAttribute(
      "data-pinned",
      "false",
    );
    await page.getByRole("button", { name: "删除选中位" }).click();
    expect(await values(page)).toEqual(["", "3", "1", "4"]);
  }
  await excluded.click();
  await expect(excluded).toHaveAttribute("aria-pressed", "false");
  await excluded.click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "新开一局", exact: true }).click();
  if (await page.getByRole("dialog").isVisible())
    await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(group(page).locator("input").first()).toHaveValue("");
  expect(await values(page)).toEqual(["", "", "", ""]);
  await expect(excluded).toHaveAttribute("aria-pressed", "false");
  await expect(group(page).locator('[data-pinned="true"]')).toHaveCount(0);
});

test("表盘双击切换对号，右键选择两种颜色，刷新保留且模式和新局互不混用", async ({
  page,
}) => {
  await page.goto("/");
  await expect(group(page)).toBeVisible();
  const seven = page.locator('.dial-number[data-digit="7"]');
  const palette = page.locator("#dial-palette");
  await seven.dblclick({ delay: 80 });
  await expect(seven).toHaveAttribute("data-checked", "true");
  await expect(seven).toHaveAttribute("aria-pressed", "false");
  await expect(seven.locator(".dial-check")).toBeVisible();
  await seven.dblclick({ delay: 80 });
  await expect(seven).toHaveAttribute("data-checked", "false");
  await expect(seven).toHaveAttribute("aria-pressed", "false");
  await seven.click();
  await expect(seven).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(350);
  await seven.dblclick({ delay: 80 });
  await expect(seven).toHaveAttribute("data-checked", "true");
  await expect(seven).toHaveAttribute("aria-pressed", "false");
  for (const [color, label] of [
    ["yellow", "黄色"],
    ["blue", "蓝色"],
  ]) {
    await seven.click({ button: "right" });
    await expect(palette).toBeVisible();
    await expect(palette).toHaveAttribute("aria-label", "数字7填充颜色");
    await palette.getByRole("button", { name: label, exact: true }).click();
    await expect(palette).not.toBeVisible();
    await expect(seven).toHaveAttribute("data-color", color);
    await expect(seven).toHaveAttribute("data-checked", "true");
    await expect(seven).toHaveAttribute("aria-pressed", "false");
  }
  await seven.click({ button: "right" });
  await expect(
    palette.getByRole("button", { name: "蓝色", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible();
  await expect(seven).toBeFocused();
  await seven.dblclick({ delay: 80 });
  await expect(seven).toHaveAttribute("data-checked", "false");
  await expect(seven).toHaveAttribute("data-color", "blue");
  await seven.click();
  await expect(seven).toHaveAttribute("aria-pressed", "true");
  await expect(seven).toHaveAttribute("data-color", "blue");
  await seven.click({ button: "right" });
  await palette.getByRole("button", { name: "清除颜色", exact: true }).click();
  await expect(seven).toHaveAttribute("data-color", "");
  await expect(seven).toHaveAttribute("aria-pressed", "true");
  await seven.click({ button: "right" });
  await palette.getByRole("button", { name: "黄色", exact: true }).click();
  await seven.dblclick({ delay: 80 });
  await enterCode(page, "0012");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0012");
  await expect(seven).toHaveAttribute("data-checked", "true");
  await expect(seven).toHaveAttribute("data-color", "yellow");
  await page.reload();
  await expect(seven).toHaveAttribute("data-checked", "true");
  await expect(seven).toHaveAttribute("data-color", "yellow");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "联机", exact: true }).click();
  await expect(seven).toHaveAttribute("data-checked", "false");
  await expect(seven).toHaveAttribute("data-color", "");
  await page.getByRole("tab", { name: "单机", exact: true }).click();
  await expect(seven).toHaveAttribute("data-checked", "true");
  await expect(seven).toHaveAttribute("data-color", "yellow");
  await page.getByRole("button", { name: "新开一局", exact: true }).click();
  if (await page.getByRole("dialog").isVisible())
    await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(group(page)).toBeVisible();
  await expect(seven).toHaveAttribute("data-checked", "false");
  await expect(seven).toHaveAttribute("data-color", "");
  await expect(seven).toHaveAttribute("aria-pressed", "false");
});

test("触屏表盘快速双击和长按选色互不误触，小屏选色盘保持在屏内", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...devices["iPhone SE"],
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(group(page)).toBeVisible();
    const seven = page.locator('.dial-number[data-digit="7"]');
    const palette = page.locator("#dial-palette");
    const rect = await seven.boundingBox();
    await page.touchscreen.tap(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    await page.touchscreen.tap(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    await expect(seven).toHaveAttribute("data-checked", "true");
    await expect(seven).toHaveAttribute("aria-pressed", "false");
    const touch = await context.newCDPSession(page);
    async function press(digit) {
      const rect = await page
        .locator(`.dial-number[data-digit="${digit}"]`)
        .boundingBox();
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        ],
      });
      await expect(palette).toBeVisible();
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(palette).toBeVisible();
      const bounds = await palette.boundingBox();
      const viewport = page.viewportSize();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    }
    await press("7");
    await expect(seven).toHaveAttribute("data-checked", "true");
    await expect(seven).toHaveAttribute("aria-pressed", "false");
    await palette.getByRole("button", { name: "黄色", exact: true }).tap();
    await expect(seven).toHaveAttribute("data-color", "yellow");
    await expect(seven).toHaveAttribute("data-checked", "true");
    for (const [digit, color] of [
      ["0", "黄色"],
      ["9", "蓝色"],
    ]) {
      await press(digit);
      await palette.getByRole("button", { name: color, exact: true }).tap();
      await expect(
        page.locator(`.dial-number[data-digit="${digit}"]`),
      ).toHaveAttribute("aria-pressed", "false");
    }
    await press("9");
    await page.screenshot({ path: "test-results/mobile-dial-colors.png" });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(palette).not.toBeVisible();
    await expect(seven).toHaveAttribute("data-checked", "true");
    await expect(seven).toHaveAttribute("data-color", "yellow");
    await press("7");
    await group(page).locator("input").first().tap();
    await expect(palette).not.toBeVisible();
    for (const digit of "0012")
      await page
        .locator(".keypad")
        .getByRole("button", { name: digit, exact: true })
        .tap();
    expect(await values(page)).toEqual(["0", "0", "1", "2"]);
    const four = await page
      .locator('.dial-number[data-digit="4"]')
      .boundingBox();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: four.x + four.width / 2, y: four.y + four.height / 2 },
      ],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: four.x + four.width / 2 - 20, y: four.y + four.height / 2 },
      ],
    });
    await page.waitForTimeout(650);
    await expect(palette).not.toBeVisible();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.reload();
    await expect(seven).toHaveAttribute("data-checked", "true");
    await expect(seven).toHaveAttribute("data-color", "yellow");
    await expect(page.locator('.dial-number[data-digit="0"]')).toHaveAttribute(
      "data-color",
      "yellow",
    );
    await expect(page.locator('.dial-number[data-digit="9"]')).toHaveAttribute(
      "data-color",
      "blue",
    );
    await assertSingleScreen(page);
  } finally {
    await context.close();
  }
});

test("两个浏览器完整对弈：房间、数字锁定、实时记录、再战", async ({
  browser,
}) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  try {
    await a.goto("/");
    await a.getByRole("button", { name: "设置", exact: true }).click();
    await a.getByRole("tab", { name: "联机", exact: true }).click();
    await a.getByRole("button", { name: "创建房间", exact: true }).click();
    const code = await a.locator(".room-code-value").innerText();
    await enterCode(a, "0012", "设置你的四位秘密数字");
    await a.getByRole("button", { name: "锁定", exact: true }).click();
    await b.goto(`/?room=${code}`);
    await expect(b.getByLabel("房间号", { exact: true })).toHaveValue(code);
    await b.getByRole("button", { name: "加入房间", exact: true }).click();
    await enterCode(b, "1122", "设置你的四位秘密数字");
    await b.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(a.getByText("你的回合", { exact: true })).toBeVisible();
    const aNote = a.locator('.dial-number[data-digit="7"]');
    const bNote = b.locator('.dial-number[data-digit="7"]');
    await aNote.dblclick({ delay: 80 });
    await aNote.click({ button: "right" });
    await a
      .locator("#dial-palette")
      .getByRole("button", { name: "蓝色", exact: true })
      .click();
    await expect(aNote).toHaveAttribute("data-checked", "true");
    await expect(aNote).toHaveAttribute("data-color", "blue");
    await expect(bNote).toHaveAttribute("data-checked", "false");
    await expect(bNote).toHaveAttribute("data-color", "");
    await expect(
      b.getByRole("button", { name: "等待", exact: true }),
    ).toBeDisabled();
    await enterCode(a, "1111", "猜测对手的四位数字");
    await group(a, "猜测对手的四位数字")
      .locator("input")
      .first()
      .click({ button: "right" });
    await a.getByRole("button", { name: "猜一下", exact: true }).click();
    await expect(b.getByText("你的回合", { exact: true })).toBeVisible();
    await enterCode(b, "0001", "猜测对手的四位数字");
    await b.getByRole("button", { name: "猜一下", exact: true }).click();
    await a.getByRole("tab", { name: "对手的猜测" }).click();
    await expect(a.locator(".guess-number")).toHaveText("0001");
    await expect(a.locator("tr[data-guess] td").nth(1)).toHaveText("3");
    await expect(a.locator("tr[data-guess] td").nth(2)).toHaveText("2");
    await a.getByRole("tab", { name: "我的猜测" }).click();
    await expect(aNote).toHaveAttribute("data-checked", "true");
    await expect(aNote).toHaveAttribute("data-color", "blue");
    expect(await values(a, "猜测对手的四位数字")).toEqual(["1", "", "", ""]);
    await group(a, "猜测对手的四位数字").locator("input").nth(1).click();
    await a.keyboard.type("122");
    await a.getByRole("button", { name: "猜一下", exact: true }).click();
    await expect(
      a.getByRole("heading", { name: "挑战成功！", exact: true }),
    ).toBeVisible();
    await expect(
      b.getByRole("heading", { name: "挑战失败", exact: true }),
    ).toBeVisible();
    await assertSingleScreen(a);
    await a.getByRole("button", { name: "再来一局", exact: true }).click();
    await b.getByRole("button", { name: "接受再战", exact: true }).click();
    await expect(group(a, "设置你的四位秘密数字")).toBeVisible();
    await expect(aNote).toHaveAttribute("data-checked", "false");
    await expect(aNote).toHaveAttribute("data-color", "");
    await a.reload();
    await expect(group(a, "设置你的四位秘密数字")).toBeVisible();
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("电脑端窄窗口正常铺满，不受横屏限制；设置集中模式、房间号和说明", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 960 });
  await page.goto("/");
  await expect(group(page)).toBeVisible();
  await expect(page.getByText("请横屏", { exact: true })).not.toBeVisible();
  await enterCode(page, "0123");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0123");
  await assertSingleScreen(page);
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const rect = await settings.boundingBox();
  expect(rect.x).toBeGreaterThan(570);
  expect(rect.y).toBeLessThan(30);
  await settings.click();
  await page.getByRole("tab", { name: "联机", exact: true }).click();
  await page.getByLabel("房间号", { exact: true }).fill("００００００");
  await expect(page.getByLabel("房间号", { exact: true })).toHaveValue(
    "000000",
  );
  await page.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(page.locator("#settings-error")).toContainText("房间不存在");
  await page.getByRole("button", { name: "玩法说明", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "玩法说明", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("数字对");
  await expect(page.getByRole("dialog")).toContainText("位置对");
  await expect(page.locator(".rules-content")).toContainText("每人累计 5 分钟");
  await expect(page.locator(".rules-content")).toContainText("第一次点击");
  await expect(page.locator(".rules-content")).not.toContainText("固定");
  await expect(page.locator(".rules-content")).not.toContainText("Enter");
  await expect(page.locator(".rules-content")).not.toContainText("排除");
  await expect(page.locator(".rules-content")).toContainText("联机");
  await page.getByRole("button", { name: "返回设置", exact: true }).click();
  await page.getByRole("tab", { name: "单机", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0123");
});

test("旧脚本和样式缓存不会被新页面引用，电脑可以正常开始猜测", async ({
  page,
}) => {
  const legacyRequests = [];
  await page.route("**/app.js", (route) => {
    legacyRequests.push("app.js");
    return route.fulfill({
      contentType: "text/javascript",
      body: 'throw new Error("legacy cached script");',
    });
  });
  await page.route("**/styles.css", (route) => {
    legacyRequests.push("styles.css");
    return route.fulfill({
      contentType: "text/css",
      body: ".game-shell { display: none; }",
    });
  });
  await page.goto("/");
  await expect(page.locator('script[src^="/assets/app."]')).toHaveCount(1);
  await expect(page.locator('link[href^="/assets/styles."]')).toHaveCount(1);
  await enterCode(page, "0123");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0123");
  expect(legacyRequests).toEqual([]);
});

test("加载请求失败时显示重试，恢复后可以开始游戏", async ({ page }) => {
  let first = true;
  await page.route("**/api/state", (route) => {
    if (first) {
      first = false;
      return route.fulfill({ status: 503, json: { error: "暂时不可用" } });
    }
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await enterCode(page, "0012");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0012");
});

test("单机不建立联机长连接，真实断网提示明确并保留输入，恢复后可以继续猜", async ({
  page,
  context,
}) => {
  let connections = 0;
  await page.routeWebSocket("**/ws", (socket) => {
    connections++;
    return socket.close();
  });
  await page.goto("/");
  await expect(group(page)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-connection", "idle");
  await enterCode(page, "0012");
  await group(page).locator("input").first().click({ button: "right" });
  const note = page.locator('.dial-number[data-digit="7"]');
  await note.dblclick({ delay: 80 });
  await note.click({ button: "right" });
  await page
    .locator("#dial-palette")
    .getByRole("button", { name: "蓝色", exact: true })
    .click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("网络不可用，请检查网络");
  expect(await values(page)).toEqual(["0", "0", "1", "2"]);
  await expect(group(page).locator("input").first()).toHaveAttribute(
    "data-pinned",
    "true",
  );
  await expect(note).toHaveAttribute("data-checked", "true");
  await expect(note).toHaveAttribute("data-color", "blue");
  await expect(page.locator(".guess-number")).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0012");
  expect(connections).toBe(0);
  await expect(page.locator("html")).toHaveAttribute("data-connection", "idle");
});

test("单机多标签通过浏览器通知同步记录和新局，不需要长连接且不清空同局草稿", async ({
  context,
}) => {
  let fixture = {
    version: 1,
    solo: { status: "playing", startedAt: 1, guesses: [] },
    room: null,
  };
  let connections = 0;
  await context.routeWebSocket("**/ws", (socket) => {
    connections++;
    return socket.close();
  });
  await context.route("**/api/state", (route) =>
    route.fulfill({ json: fixture }),
  );
  await context.route("**/api/solo/guess", (route) => {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: {
        ...fixture.solo,
        guesses: [
          {
            guess: route.request().postDataJSON().guess,
            digits: 0,
            positions: 0,
          },
        ],
      },
    };
    return route.fulfill({ json: fixture });
  });
  await context.route("**/api/solo/start", (route) => {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: { status: "playing", startedAt: 2, guesses: [] },
    };
    return route.fulfill({ json: fixture });
  });
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/");
  await b.goto("/");
  await enterCode(b, "9012");
  await enterCode(a, "0012");
  await a.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(a.locator(".guess-number")).toHaveText("0012");
  await expect(b.locator(".guess-number")).toHaveText("0012");
  expect(await values(b)).toEqual(["9", "0", "1", "2"]);
  await a.getByRole("button", { name: "设置", exact: true }).click();
  await a.getByRole("button", { name: "新开一局", exact: true }).click();
  await a.getByRole("button", { name: "确定", exact: true }).click();
  await expect(b.locator(".guess-number")).toHaveCount(0);
  await expect(group(b).locator("input").first()).toHaveValue("");
  expect(await values(b)).toEqual(["", "", "", ""]);
  expect(connections).toBe(0);
});

test("联机短暂断线自动恢复记录，切单机和切后台不弹断线提示，回前台重新同步", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem("guessnum_mode", "duel"));
  let fixture = {
    version: 1,
    solo: { status: "playing", startedAt: 1, guesses: [] },
    room: {
      code: "123456",
      phase: "playing",
      match: 1,
      turn: "you",
      winner: null,
      you: {
        name: "玩家一",
        ready: true,
        secret: "0012",
        guesses: [],
        rematch: false,
      },
      opponent: {
        name: "玩家二",
        ready: true,
        online: true,
        guesses: [],
        rematch: false,
      },
    },
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
  const sockets = [];
  await page.routeWebSocket("**/ws", (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "state", ...fixture }));
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  await enterCode(page, "0123", "猜测对手的四位数字");
  await group(page, "猜测对手的四位数字")
    .locator("input")
    .first()
    .click({ button: "right" });
  fixture = {
    ...fixture,
    version: 2,
    room: {
      ...fixture.room,
      opponent: {
        ...fixture.room.opponent,
        guesses: [{ guess: "0001", digits: 3, positions: 2 }],
      },
    },
  };
  await sockets[0].close({ code: 1012, reason: "restart" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "offline",
  );
  await expect(page.locator("#toast")).not.toBeVisible();
  await page.clock.runFor(1100);
  await expect.poll(() => sockets.length).toBe(2);
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  expect(await values(page, "猜测对手的四位数字")).toEqual([
    "0",
    "1",
    "2",
    "3",
  ]);
  await expect(
    group(page, "猜测对手的四位数字").locator("input").first(),
  ).toHaveAttribute("data-pinned", "true");
  await page.getByRole("tab", { name: "对手的猜测", exact: true }).click();
  await expect(page.locator(".guess-number")).toHaveText("0001");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "单机", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-connection", "idle");
  await page.clock.runFor(10_000);
  expect(sockets.length).toBe(2);
  await expect(page.locator("#toast")).not.toBeVisible();
  await page.getByRole("tab", { name: "联机", exact: true }).click();
  await expect.poll(() => sockets.length).toBe(3);
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-connection", "idle");
  await page.clock.runFor(10_000);
  expect(sockets.length).toBe(3);
  await expect(page.locator("#toast")).not.toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => sockets.length).toBe(4);
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  await expect(page.locator("#toast")).not.toBeVisible();
});

test("联机持续断线才提示，恢复后清除提示，旧连接关闭不干扰新连接", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.setItem("guessnum_mode", "duel");
    const sockets = [];
    class ControlledSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      constructor() {
        super();
        sockets.push(this);
      }
      close() {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      open() {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    }
    window.WebSocket = ControlledSocket;
    window.testConnections = sockets;
  });
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        version: 1,
        solo: { status: "playing", startedAt: 1, guesses: [] },
        room: {
          code: "123456",
          phase: "playing",
          match: 1,
          turn: "you",
          winner: null,
          you: {
            name: "玩家一",
            ready: true,
            secret: "0012",
            guesses: [],
            rematch: false,
          },
          opponent: {
            name: "玩家二",
            ready: true,
            guesses: [],
            rematch: false,
          },
        },
      },
    }),
  );
  await page.goto("/");
  await expect(group(page, "猜测对手的四位数字")).toBeVisible();
  await page.evaluate(() => window.testConnections[0].open());
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  await page.evaluate(() => window.testConnections[0].close());
  await page.clock.runFor(5500);
  await expect(page.locator("#toast")).not.toBeVisible();
  expect(await page.evaluate(() => window.testConnections.length)).toBe(2);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.clock.runFor(600);
  await expect(page.locator("#settings-error")).toHaveText(
    "联机连接暂时断开，正在重连",
  );
  await expect(page.locator("#settings-error")).toBeVisible();
  await page.evaluate(() => window.testConnections[1].open());
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  await expect(page.locator("#settings-error")).not.toBeVisible();
  await page.evaluate(() => window.testConnections[0].close());
  await page.clock.runFor(10_000);
  await expect(page.locator("html")).toHaveAttribute(
    "data-connection",
    "online",
  );
  expect(await page.evaluate(() => window.testConnections.length)).toBe(2);
});

test("手机竖屏依次显示记录、表盘和输入键盘，长按固定及旋转后保留输入", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    userAgent: devices["iPhone 13"].userAgent,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(group(page)).toBeVisible();
    await group(page).locator("input").first().tap();
    for (const digit of "0012")
      await page
        .locator(".keypad")
        .getByRole("button", { name: digit, exact: true })
        .tap();
    const input = group(page).locator("input").nth(1);
    const touch = await context.newCDPSession(page);
    const press = async () => {
      const rect = await input.boundingBox();
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        ],
      });
    };
    await press();
    await expect(input).toHaveAttribute("data-pinned", "true");
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await input.tap();
    await page.getByRole("button", { name: "删除选中位" }).tap();
    expect(await values(page)).toEqual(["0", "0", "1", "2"]);
    await press();
    await expect(input).toHaveAttribute("data-pinned", "false");
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await input.tap();
    await page.getByRole("button", { name: "删除选中位" }).tap();
    expect(await values(page)).toEqual(["0", "", "1", "2"]);
    await page
      .locator(".keypad")
      .getByRole("button", { name: "0", exact: true })
      .tap();
    await page.getByRole("button", { name: "猜一下", exact: true }).tap();
    await expect(page.locator(".guess-number")).toHaveText("0012");
    await assertSingleScreen(page);
    await page.screenshot({ path: "test-results/mobile-initial.png" });
    await page.setViewportSize({ width: 375, height: 812 });
    if (!(await group(page).isVisible()))
      await page.getByRole("button", { name: "再来一局", exact: true }).tap();
    await expect(group(page)).toBeVisible();
    await assertSingleScreen(page);
    await group(page).locator("input").first().tap();
    for (const digit of "0201")
      await page
        .locator(".keypad")
        .getByRole("button", { name: digit, exact: true })
        .tap();
    await press();
    await expect(input).toHaveAttribute("data-pinned", "true");
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page
      .getByRole("button", { name: "标记数字7为排除", exact: true })
      .tap();
    await page.screenshot({ path: "test-results/mobile-portrait.png" });
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(group(page)).toBeVisible();
      await assertSingleScreen(page);
      expect(await values(page)).toEqual(["0", "2", "0", "1"]);
      await expect(input).toHaveAttribute("data-pinned", "true");
    }
    await page.setViewportSize({ width: 812, height: 375 });
    await expect(page.getByText("请竖屏", { exact: true })).toBeVisible();
    await expect(group(page)).not.toBeVisible();
    await page.screenshot({ path: "test-results/mobile-landscape-prompt.png" });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(group(page)).toBeVisible();
    expect(await values(page)).toEqual(["0", "2", "0", "1"]);
    await expect(input).toHaveAttribute("data-pinned", "true");
    await expect(
      page.getByRole("button", { name: "标记数字7为排除", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "猜一下", exact: true }).tap();
    await expect(page.locator(".guess-number").last()).toHaveText("0201");
    await assertLatestAtBottom(page);
  } finally {
    await context.close();
  }
});

test("两联各 8 行从底部追加，第 9 次进入右联，第 16 次失败并显示答案", async ({
  page,
}) => {
  const makeGuesses = (count) =>
    Array.from({ length: count }, (_, i) => ({
      guess: String(i).padStart(4, "0"),
      digits: 1,
      positions: 0,
    }));
  let fixture = {
    version: 1,
    solo: { status: "playing", startedAt: 1, guesses: makeGuesses(2) },
    room: null,
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/solo/guess", (route) => {
    const { guess } = route.request().postDataJSON();
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: {
        ...fixture.solo,
        status: "lost",
        answer: "9999",
        guesses: [...fixture.solo.guesses, { guess, digits: 0, positions: 0 }],
      },
    };
    return route.fulfill({ json: fixture });
  });
  await page.route("**/api/solo/start", (route) => {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: { status: "playing", startedAt: 2, guesses: [] },
    };
    return route.fulfill({ json: fixture });
  });
  await page.goto("/");
  await expect(page).toHaveTitle("数字炸弹");
  await expect(page.locator(".history-table")).toHaveCount(2);
  await expect(
    page.locator(".history-table").nth(0).locator("tbody tr"),
  ).toHaveCount(8);
  await expect(
    page.locator(".history-table").nth(1).locator("tbody tr"),
  ).toHaveCount(8);
  await expect(page.locator(".guess-number")).toHaveText(["0000", "0001"]);
  await assertLatestAtBottom(page);
  for (const count of [8, 9, 15]) {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: { ...fixture.solo, guesses: makeGuesses(count) },
    };
    await page.reload();
    await expect(page.locator("tr[data-guess]")).toHaveCount(count);
    await expect(
      page.locator(".history-table").nth(0).locator(".guess-number"),
    ).toHaveCount(8);
    await expect(
      page.locator(".history-table").nth(1).locator(".guess-number"),
    ).toHaveCount(count - 8);
    await assertLatestAtBottom(page);
  }
  await enterCode(page, "5678");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "次数用尽", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".result-code")).toHaveText("9999");
  await expect(page.locator("tr[data-guess]")).toHaveCount(16);
  await expect(page.locator(".guess-number").last()).toHaveText("5678");
  for (const viewport of [
    { width: 568, height: 320 },
    { width: 812, height: 375 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await assertSingleScreen(page);
    await assertLatestAtBottom(page);
    await expect(page.locator("tbody tr")).toHaveCount(16);
  }
  await page.screenshot({ path: "test-results/desktop-sixteen.png" });
  await page.getByRole("button", { name: "再来一局", exact: true }).click();
  await expect(group(page)).toBeVisible();
  await expect(page.locator(".guess-number")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(16);
});

test("手机小屏能完整显示两联 16 行记录", async ({ browser }) => {
  const context = await browser.newContext({
    ...devices["iPhone SE"],
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const fixture = {
    version: 1,
    solo: {
      status: "lost",
      answer: "9999",
      startedAt: 1,
      guesses: Array.from({ length: 16 }, (_, i) => ({
        guess: String(i).padStart(4, "0"),
        digits: i % 5,
        positions: i % 3,
      })),
    },
    room: null,
  };
  try {
    await page.route("**/api/state", (route) =>
      route.fulfill({ json: fixture }),
    );
    await page.routeWebSocket("**/ws", () => {});
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "次数用尽", exact: true }),
    ).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(16);
    await expect(page.locator(".guess-number")).toHaveCount(16);
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await assertSingleScreen(page);
      await assertLatestAtBottom(page);
      const visible = await page
        .locator("tbody td")
        .evaluateAll((cells) =>
          cells.every(
            (cell) =>
              cell.scrollWidth <= cell.clientWidth + 1 &&
              cell.clientHeight >= 18,
          ),
        );
      expect(visible).toBe(true);
      await page.screenshot({
        path: `test-results/mobile-sixteen-${viewport.width}.png`,
      });
    }
  } finally {
    await context.close();
  }
});

test("联机 16 次后双方显示流局，记录保留并可再战", async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const a = await aContext.newPage();
  const b = await bContext.newPage();
  const post = async (context, path, data) => {
    const response = await context.request.post(path, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    const created = await post(aContext, "/api/rooms/create", {});
    const code = created.room.code;
    await post(bContext, "/api/rooms/join", { code });
    await post(aContext, "/api/rooms/secret", { secret: "0012" });
    await post(bContext, "/api/rooms/secret", { secret: "1122" });
    await a.goto(`/?room=${code}`);
    await b.goto(`/?room=${code}`);
    await expect(a.getByText("你的回合", { exact: true })).toBeVisible();
    for (let i = 0; i < 16; i++) {
      await post(aContext, "/api/rooms/guess", { guess: String(9000 + i) });
      if (i === 15) {
        await expect(b.getByText("你的回合", { exact: true })).toBeVisible();
        await expect(
          b.getByRole("heading", { name: "本局流局", exact: true }),
        ).not.toBeVisible();
      }
      await post(bContext, "/api/rooms/guess", { guess: String(8000 + i) });
    }
    for (const player of [a, b]) {
      await expect(
        player.getByRole("heading", { name: "本局流局", exact: true }),
      ).toBeVisible();
      await expect(player.locator(".guess-number")).toHaveCount(16);
      await expect(
        player.locator(".history-table").nth(1).locator(".guess-number"),
      ).toHaveCount(8);
      await player.getByRole("tab", { name: "对手的猜测" }).click();
      await expect(player.locator(".guess-number")).toHaveCount(16);
      await assertSingleScreen(player);
    }
    await a.getByRole("button", { name: "再来一局", exact: true }).click();
    await b.getByRole("button", { name: "接受再战", exact: true }).click();
    await expect(group(a, "设置你的四位秘密数字")).toBeVisible();
    await expect(a.locator(".guess-number")).toHaveCount(0);
    await expect(b.locator(".guess-number")).toHaveCount(0);
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("单机首猜启动倒计时，重复猜测简短提示，低时变色且自动同步超时和新局", async ({
  page,
}) => {
  const now = Date.UTC(2026, 9, 22, 0, 0, 0);
  await page.clock.install({ time: new Date(now) });
  let fixture = {
    version: 1,
    serverNow: now,
    timeLimitMs: 300_000,
    solo: {
      status: "playing",
      startedAt: now,
      guesses: [],
      clock: { elapsedMs: 0, runningSince: null },
    },
    room: null,
  };
  let submissions = 0;
  await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/solo/guess", (route) => {
    submissions++;
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      serverNow: now + 30_000,
      solo: {
        ...fixture.solo,
        guesses: [{ guess: "1234", digits: 3, positions: 1 }],
        clock: { elapsedMs: 0, runningSince: now + 30_000 },
      },
    };
    return route.fulfill({ json: fixture });
  });
  await page.route("**/api/solo/start", (route) => {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      solo: {
        status: "playing",
        startedAt: now + 400_000,
        guesses: [],
        clock: { elapsedMs: 0, runningSince: null },
      },
    };
    return route.fulfill({ json: fixture });
  });
  await page.goto("/");
  const clock = page.getByRole("timer", { name: "单机剩余时间" });
  await expect(clock).toContainText("首猜起计时");
  await page.clock.fastForward(30_000);
  await expect(clock.locator("b")).toHaveText("05:00");
  await expect(clock).toHaveAttribute("data-running", "false");
  await enterCode(page, "1234");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(clock).toHaveAttribute("data-running", "true");
  await page.clock.setSystemTime(new Date("2050-01-01T00:00:00Z"));
  await page.clock.runFor(2100);
  await expect(clock.locator("b")).toHaveText("04:58");
  await enterCode(page, "1234");
  await page.getByRole("button", { name: "猜一下", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("这个数字已经猜过了");
  expect(submissions).toBe(1);
  expect(await values(page)).toEqual(["1", "2", "3", "4"]);
  await enterCode(page, "5678");
  const focused = await page.locator(":focus").getAttribute("id");
  await page.clock.fastForward(238_000);
  await expect(clock).toHaveAttribute("data-low", "true");
  await expect(page.locator("#toast")).not.toBeVisible();
  expect(await values(page)).toEqual(["5", "6", "7", "8"]);
  await expect(page.locator(":focus")).toHaveAttribute("id", focused);
  await page.clock.runFor(4000);
  await expect(page.locator("#toast")).not.toBeVisible();
  fixture = {
    ...fixture,
    version: fixture.version + 1,
    serverNow: now + 330_000,
    solo: {
      ...fixture.solo,
      status: "lost",
      reason: "timeout",
      answer: "0012",
      clock: { elapsedMs: 300_000, runningSince: null },
    },
  };
  await page.clock.fastForward(60_000);
  await expect(
    page.getByRole("heading", { name: "时间超时", exact: true }),
  ).toBeVisible();
  await expect(clock.locator("b")).toHaveText("00:00");
  await expect(page.locator(".result-code")).toHaveText("0012");
  await expect(page.locator(".guess-number")).toHaveText("1234");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "时间超时", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "再来一局", exact: true }).click();
  await expect(clock.locator("b")).toHaveText("05:00");
  await expect(clock).toHaveAttribute("data-running", "false");
  await expect(page.locator(".guess-number")).toHaveCount(0);
});

test("联机双方倒计时只随本方回合运行，超时结果同步后再战重置", async ({
  page,
}) => {
  const now = Date.UTC(2026, 9, 22, 0, 0, 0);
  await page.clock.install({ time: new Date(now) });
  await page.addInitScript(() => localStorage.setItem("guessnum_mode", "duel"));
  let fixture = {
    version: 1,
    serverNow: now,
    timeLimitMs: 300_000,
    solo: { status: "playing", startedAt: now, guesses: [] },
    room: {
      code: "123456",
      phase: "playing",
      match: 1,
      turn: "you",
      winner: null,
      you: {
        name: "玩家一",
        ready: true,
        secret: "0012",
        guesses: [],
        rematch: false,
        clock: { elapsedMs: 40_000, runningSince: now },
      },
      opponent: {
        name: "玩家二",
        ready: true,
        online: true,
        guesses: [],
        rematch: false,
        clock: { elapsedMs: 15_000, runningSince: null },
      },
    },
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
  let socket;
  await page.routeWebSocket("**/ws", (current) => {
    socket = current;
  });
  await page.route("**/api/rooms/rematch", (route) => {
    fixture = {
      ...fixture,
      version: fixture.version + 1,
      room: {
        ...fixture.room,
        phase: "setup",
        match: 2,
        reason: null,
        winner: null,
        turn: null,
        you: {
          ...fixture.room.you,
          ready: false,
          secret: null,
          clock: { elapsedMs: 0, runningSince: null },
        },
        opponent: {
          ...fixture.room.opponent,
          ready: false,
          secret: null,
          clock: { elapsedMs: 0, runningSince: null },
        },
      },
    };
    return route.fulfill({ json: fixture });
  });
  await page.goto("/");
  const you = page.getByRole("timer", { name: "我的剩余时间" });
  const opponent = page.getByRole("timer", { name: "对手剩余时间" });
  await expect(you).toHaveAttribute("data-running", "true");
  await expect(opponent).toHaveAttribute("data-running", "false");
  await expect.poll(() => Boolean(socket)).toBe(true);
  await page.clock.runFor(2200);
  await expect(you.locator("b")).toHaveText("04:18");
  await expect(opponent.locator("b")).toHaveText("04:45");
  fixture = {
    ...fixture,
    version: fixture.version + 1,
    serverNow: now + 2200,
    room: {
      ...fixture.room,
      turn: "opponent",
      you: {
        ...fixture.room.you,
        clock: { elapsedMs: 42_200, runningSince: null },
      },
      opponent: {
        ...fixture.room.opponent,
        clock: { elapsedMs: 15_000, runningSince: now + 2200 },
      },
    },
  };
  socket.send(JSON.stringify({ type: "state", ...fixture }));
  await expect(you).toHaveAttribute("data-running", "false");
  await expect(opponent).toHaveAttribute("data-running", "true");
  await page.clock.runFor(5000);
  await expect(you.locator("b")).toHaveText("04:18");
  await expect(opponent.locator("b")).toHaveText("04:40");
  fixture = {
    ...fixture,
    version: fixture.version + 1,
    serverNow: now + 300_000,
    room: {
      ...fixture.room,
      phase: "finished",
      reason: "timeout",
      winner: "you",
      turn: null,
      opponent: {
        ...fixture.room.opponent,
        secret: "1122",
        clock: { elapsedMs: 300_000, runningSince: null },
      },
    },
  };
  socket.send(JSON.stringify({ type: "state", ...fixture }));
  await expect(
    page.getByRole("heading", { name: "对手超时！", exact: true }),
  ).toBeVisible();
  await expect(opponent.locator("b")).toHaveText("00:00");
  await expect(page.locator(".result-code")).toHaveText("1122");
  await page.getByRole("button", { name: "再来一局", exact: true }).click();
  await expect(group(page, "设置你的四位秘密数字")).toBeVisible();
  for (const clock of [you, opponent]) {
    await expect(clock.locator("b")).toHaveText("05:00");
    await expect(clock).toHaveAttribute("data-running", "false");
  }
});

for (const mobile of [false, true]) {
  test(`${mobile ? "手机竖屏" : "电脑端"}成功、次数用尽、超时和揭晓结果清晰放大且不溢出`, async ({
    browser,
  }) => {
    const context = await browser.newContext(
      mobile ? { ...devices["iPhone SE"], deviceScaleFactor: 1 } : {},
    );
    const page = await context.newPage();
    const cases = [
      {
        status: "won",
        reason: "guessed",
        title: "挑战成功！",
        elapsedMs: 48_000,
      },
      { status: "lost", reason: "limit", title: "次数用尽", elapsedMs: 90_000 },
      {
        status: "lost",
        reason: "timeout",
        title: "时间超时",
        elapsedMs: 300_000,
      },
      {
        status: "revealed",
        reason: "revealed",
        title: "答案揭晓",
        elapsedMs: 25_000,
      },
      {
        duel: true,
        reason: "guessed",
        winner: "you",
        title: "挑战成功！",
        elapsedMs: 48_000,
      },
      {
        duel: true,
        reason: "timeout",
        winner: "opponent",
        title: "时间超时",
        elapsedMs: 300_000,
      },
      {
        duel: true,
        reason: "limit",
        winner: null,
        title: "本局流局",
        elapsedMs: 90_000,
      },
    ];
    let fixture;
    await page.route("**/api/state", (route) =>
      route.fulfill({ json: fixture }),
    );
    await page.routeWebSocket("**/ws", () => {});
    try {
      for (const [index, item] of cases.entries()) {
        const guesses = Array.from(
          { length: item.reason === "limit" ? 16 : 3 },
          (_, i) => ({ guess: String(9000 + i), digits: 1, positions: 0 }),
        );
        const clock = { elapsedMs: item.elapsedMs, runningSince: null };
        fixture = {
          version: index + 1,
          solo: {
            status: item.status || "playing",
            reason: item.reason,
            startedAt: index + 1,
            answer: "0012",
            guesses,
            clock,
          },
          room: item.duel
            ? {
                code: "123456",
                phase: "finished",
                match: 1,
                turn: null,
                winner: item.winner,
                reason: item.reason,
                you: {
                  name: "玩家一",
                  ready: true,
                  secret: "0012",
                  guesses,
                  rematch: false,
                  clock,
                },
                opponent: {
                  name: "玩家二",
                  ready: true,
                  secret: "1122",
                  online: true,
                  guesses,
                  rematch: false,
                  clock: { elapsedMs: 45_000, runningSince: null },
                },
              }
            : null,
        };
        for (const viewport of mobile
          ? [
              { width: 320, height: 568 },
              { width: 375, height: 812 },
              { width: 768, height: 1024 },
            ]
          : [
              { width: 568, height: 320 },
              { width: 640, height: 960 },
              { width: 1440, height: 900 },
            ]) {
          await page.setViewportSize(viewport);
          await page.goto(item.duel ? "/?room=123456" : "/");
          const heading = page.getByRole("heading", {
            name: item.title,
            exact: true,
          });
          await expect(heading).toBeVisible();
          expect(
            await heading.evaluate((element) =>
              parseFloat(getComputedStyle(element).fontSize),
            ),
          ).toBeGreaterThanOrEqual(22);
          await assertSingleScreen(page);
          await expect(page.locator("tbody tr")).toHaveCount(16);
          await expect(
            page.getByRole("button", { name: "再来一局", exact: true }),
          ).toBeVisible();
          if (viewport.width === (mobile ? 375 : 1440))
            await page.screenshot({
              path: `test-results/${mobile ? "mobile" : "desktop"}-${item.duel ? "duel-" : ""}${item.reason}.png`,
            });
        }
      }
    } finally {
      await context.close();
    }
  });
}
