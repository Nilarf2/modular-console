import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function navigate(page: Page, label: string, mobile = false) {
  if (mobile) await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

test("demo renders real widgets and all mobile screens fit 390px", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:19471");
  await expect(
    page.getByRole("heading", { name: "控制台", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("示例模式", { exact: true })).toBeVisible();
  await expect(page.locator(".widget-card")).toHaveCount(3);
  await expect(page.getByText("实时", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    for (const label of ["组件", "节点", "连接", "设置", "总览"]) {
      await navigate(page, label, true);
      await noOverflow(page);
    }
    await page.getByRole("button", { name: "添加组件", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noOverflow(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("authenticated node and widget CRUD persist, history and password flows work", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const password = readFileSync(
    process.env.CONSOLE_E2E_PASSWORD_FILE!,
    "utf8",
  ).trim();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:19470");
  await page.getByLabel("访问密码").fill(password);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await expect(
    page.getByRole("heading", { name: "控制台", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "暂无组件" })).toBeVisible();
  await navigate(page, "节点");
  await page
    .getByRole("button", { name: "注册节点", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("节点名称").fill("集成测试节点");
  await dialog.getByRole("button", { name: "注册节点", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "保存节点凭据" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("节点令牌")).not.toHaveValue("");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载配置 JSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await dialog.getByRole("button", { name: "我已保存" }).click();
  await expect(
    page.getByRole("button", { name: "编辑 集成测试节点", exact: true }),
  ).toBeVisible();
  await navigate(page, "总览");
  await page
    .getByRole("button", { name: "添加组件", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "插件", exact: true })
    .selectOption("hosts");
  await dialog
    .getByRole("combobox", { name: "组件类型", exact: true })
    .selectOption("node-basic");
  await dialog
    .getByRole("combobox", { name: "节点", exact: true })
    .selectOption({ label: "集成测试节点" });
  await dialog.getByLabel("组件标题").fill("测试资源卡片");
  await dialog.getByRole("button", { name: "添加组件", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "测试资源卡片", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".widget-card .metric-value").first()).toHaveText(
    "—",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "测试资源卡片", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "编辑 测试资源卡片", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("组件标题").fill("重命名卡片");
  await dialog.getByRole("button", { name: "宽幅 · 2 列" }).click();
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(page.locator(".widget-card.wide")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "重命名卡片" })).toBeVisible();
  await page.getByRole("button", { name: "历史趋势" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "24 小时" }).click();
  await expect(page.getByText("这个时间段还没有历史数据")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "编辑布局", exact: true }).click();
  await page
    .getByRole("button", { name: "删除 重命名卡片", exact: true })
    .click();
  await expect(page.locator(".widget-card")).toHaveCount(0);
  await navigate(page, "节点");
  await page.getByRole("button", { name: "轮换 集成测试节点 的令牌" }).click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "保存节点凭据" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "我已保存" }).click();
  await page
    .getByRole("button", { name: "删除 集成测试节点", exact: true })
    .click();
  await page.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(page.getByRole("heading", { name: "暂无节点" })).toBeVisible();
  await navigate(page, "设置");
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  const nextPassword = randomBytes(24).toString("base64url");
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("当前密码", { exact: true }).fill(password);
  await dialog.getByLabel("新密码", { exact: true }).fill(nextPassword);
  await dialog.getByLabel("确认新密码", { exact: true }).fill(nextPassword);
  await dialog.getByRole("button", { name: "保存并重新登录" }).click();
  await expect(
    page.getByRole("heading", { name: "登录", exact: true }),
  ).toBeVisible();
  await page.getByLabel("访问密码").fill(nextPassword);
  await page.getByRole("button", { name: "进入控制台" }).click();
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  expect(errors).toEqual([]);
});
