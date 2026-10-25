import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
test('institution setup, enrollment, search, preview and isolation in real browser', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5174/admin/');
  await expect(
    page.getByRole('button', { name: /^(Создать администратора|Войти)$/ }),
  ).toBeEnabled();
  if (await page.getByRole('heading', { name: 'Первоначальная настройка' }).isVisible()) {
    await page.getByLabel('Имя администратора').fill('acceptance-admin');
    await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password-1234');
    await page.getByLabel('Код первоначальной настройки').fill('demo-setup-local');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
  } else {
    await page.getByLabel('Имя администратора').fill('acceptance-admin');
    await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password-1234');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Учреждение', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Клиника «Север»', exact: true }).click();
  await page.getByRole('button', { name: 'Опубликовать настройки' }).click();
  await expect(page.getByText('Новая версия опубликована.', { exact: false })).toBeVisible();
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/admin.png', fullPage: true });
  await page.getByRole('button', { name: 'Терминалы', exact: true }).click();
  await page.getByLabel('Название терминала', { exact: true }).fill('Тестовый терминал');
  await page.getByRole('button', { name: 'Создать код регистрации' }).click();
  const code = await page.getByLabel('Одноразовый код', { exact: true }).inputValue();
  expect(code.length).toBeGreaterThan(20);
  const terminal = await context.newPage();
  terminal.on('pageerror', (e) => errors.push(e.message));
  await terminal.goto('http://127.0.0.1:5173');
  await terminal.getByLabel('Адрес шлюза').fill('http://127.0.0.1:8787');
  await terminal.getByLabel('Код регистрации').fill(code);
  await terminal.getByRole('button', { name: 'Подключить', exact: true }).click();
  await expect(terminal.getByRole('button', { name: 'Получить результаты' })).toBeEnabled();
  await expect(terminal.getByText('Клиника «Север»', { exact: true })).toBeVisible();
  await terminal.screenshot({ path: 'docs/screenshots/terminal-desktop.png', fullPage: true });
  await terminal.setViewportSize({ width: 1080, height: 1920 });
  await terminal.screenshot({ path: 'docs/screenshots/terminal-portrait.png', fullPage: true });
  await terminal.getByRole('button', { name: 'Получить результаты' }).click();
  await terminal.getByRole('button', { name: 'Полис ОМС и дата рождения' }).click();
  await terminal.getByLabel('Номер полиса ОМС', { exact: true }).fill('0000000000000001');
  await terminal.getByLabel('Дата рождения', { exact: true }).fill('2000-01-01');
  await terminal.getByRole('button', { name: 'Найти результаты' }).click();
  await expect(terminal.getByRole('heading', { name: 'Результаты исследований' })).toBeVisible();
  await terminal.getByRole('checkbox').first().check();
  await expect(terminal.getByRole('button', { name: 'Распечатать' })).toBeDisabled();
  await terminal.getByRole('button', { name: 'Просмотреть' }).first().click();
  await expect(terminal.locator('canvas')).toBeVisible();
  await expect
    .poll(() => terminal.locator('canvas').evaluate((c) => (c as HTMLCanvasElement).width))
    .toBeGreaterThan(500);
  await terminal.screenshot({ path: 'docs/screenshots/pdf.png', fullPage: true });
  await terminal.getByRole('button', { name: 'Завершить сеанс' }).click();
  await expect(terminal.getByRole('button', { name: 'Получить результаты' })).toBeVisible();
  await expect(terminal.getByText('Тестовый пациент', { exact: false })).toHaveCount(0);
  await terminal.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => terminal.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await terminal.screenshot({ path: 'docs/screenshots/terminal-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('device monitoring shows explicit offline and unknown states', async ({ page }) => {
  const headers = { 'x-rt-admin': '1' };
  await page.request.post('http://127.0.0.1:5174/api/admin/login', {
    headers,
    data: { username: 'acceptance-admin', password: 'synthetic-password-1234' },
  });
  const e = await page.request.post('http://127.0.0.1:5174/api/admin/enrollments', {
    headers,
    data: { name: 'Проверка мониторинга' },
  });
  const pair = await page.request.post('http://127.0.0.1:5174/api/v1/enroll', {
    data: { code: (await e.json()).code },
  });
  const token = (await pair.json()).token;
  const health = {
    checkedAt: new Date().toISOString(),
    os: 'windows',
    uptimeSeconds: 7200,
    cpuPercent: 42,
    memoryTotalMb: 8192,
    memoryUsedMb: 2048,
    diskFreeGb: 24,
    scanner: { state: 'unknown', code: 'HID_UNVERIFIED' },
    printer: { state: 'disconnected', code: 'OFFLINE' },
  };
  const heartbeat = await page.request.post('http://127.0.0.1:5174/api/v1/heartbeat', {
    headers: { authorization: `Bearer ${token}` },
    data: { version: '0.1.0', health },
  });
  expect(heartbeat.status()).toBe(200);
  await page.goto('http://127.0.0.1:5174/admin/');
  await expect(page.getByRole('heading', { name: 'Учреждение', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Терминалы', exact: true }).click();
  await expect(page.getByText('Принтер: Нет соединения', { exact: true })).toBeVisible();
  await expect(page.getByText('Сканер: Не проверено', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/monitoring.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: 'docs/screenshots/admin-mobile.png', fullPage: true });
});
