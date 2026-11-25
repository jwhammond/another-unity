// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/debug';
import { gameLifted, NEEDS_GAME, quiet, settled, watchConsole } from './helpers';

// SETTINGS > GAME > SEND FEEDBACK (functions/api/feedback.ts): the demo's away mission, with the Pages Function and Turnstile stood in for
// (the dev server has neither: a real round trip is deploy:preview's). The stand-in Turnstile passes at once, as the real one does for most.

const padd = (page: Page) => page.getByRole('dialog', { name: 'Admin console' });
const inPadd = (page: Page, name: string) => padd(page).getByRole('button', { name, exact: true });

const FAKE_TURNSTILE = `window.turnstile = {
  render(el, o) { el.dataset.sitekey = o.sitekey; el.dataset.action = o.action; setTimeout(() => o.callback('fake-token'), 50); return 'w1'; },
  reset() { window.__resets = (window.__resets || 0) + 1; },
  remove() {},
};`;

async function standIns(page: Page) {
  const posted: unknown[] = [];
  await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }));
  await page.route('**/api/feedback', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { siteKey: 'test-site-key' } });
    posted.push(r.request().postDataJSON());
    return r.fulfill({ status: 201, json: { id: 'abcd1234' } });
  });
  return posted;
}

test('a player writes a report and sends it: where they are, their settings, the build, errors and the save go with it', async ({ page }) => {
  const errors = watchConsole(page);
  const posted = await standIns(page);
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);

  // (the bar's Feedback opens the console on its page)
  await page.locator('.au-menus').getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(padd(page).getByRole('status')).toHaveText('Send feedback');
  await expect(padd(page).locator('.au-admin-check')).toHaveAttribute('data-sitekey', 'test-site-key');
  await expect(padd(page).locator('.au-admin-check')).toHaveAttribute('data-action', 'feedback');

  const message = padd(page).getByRole('textbox', { name: 'What happened' });
  await message.click();
  // (keys the game would take, L for Look and Space, go into the message; Enter makes a new line)
  await page.keyboard.type('Look here. Space works');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await expect(message).toHaveValue('Look here. Space works\nsecond line');
  await expect(page.locator('.au-verbs button[aria-pressed="true"]')).toHaveText('Walk');
  await padd(page).getByRole('textbox', { name: /Email/ }).fill('player@example.com');

  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/feedback-page.png` });
  await inPadd(page, 'SEND').click();
  await expect(padd(page).getByRole('status')).toHaveText('Thank you: report abcd1234 sent');
  await expect(message).toHaveValue('');
  expect(posted).toHaveLength(1);
  const body = posted[0] as Record<string, any>;
  expect(body).toMatchObject({ message: 'Look here. Space works\nsecond line', email: 'player@example.com', token: 'fake-token', trap: '', saveNote: null });
  expect(body.game).toMatchObject({ game: 'demo', onShip: false, combat: null, currentActor: 'picard' });
  expect(typeof body.game.screen).toBe('string');
  expect(body.game.settings).toHaveProperty('master');
  expect(JSON.parse(body.save)).toHaveProperty('version');
  expect(body.client).toMatchObject({ build: 'dev', path: '/play/afu/' });
  expect(Array.isArray(body.errors)).toBe(true);
  // (a token is good for one send: the check starts again)
  expect(await page.evaluate(() => (window as unknown as { __resets?: number }).__resets)).toBe(1);
  expect(errors).toEqual([]);
});

test("without the site's feedback (the dev server's own answer), the page says so and SEND stays off", async ({ page }) => {
  await page.goto('/play/afu/?game=demo&speed=4&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await page.keyboard.press('Escape');
  await inPadd(page, 'SETTINGS').click();
  await inPadd(page, 'SEND FEEDBACK').click();
  await expect(padd(page).getByRole('status')).toHaveText('Feedback cannot be sent from here');
  await expect(inPadd(page, 'SEND')).toBeDisabled();
});

test('the bridge: FEEDBACK on the console\'s face, drawn with the original\'s art (screenshot with SHOTS)', async ({ page }) => {
  test.skip(!gameLifted, NEEDS_GAME);
  await standIns(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.keyboard.press('Escape');
  await expect(inPadd(page, 'FEEDBACK')).toBeVisible();
  if (process.env.SHOTS) await padd(page).screenshot({ path: `${process.env.SHOTS}/feedback-face.png` });
  await inPadd(page, 'FEEDBACK').click();
  await expect(padd(page).getByRole('status')).toHaveText('Send feedback');
  if (process.env.SHOTS) await padd(page).screenshot({ path: `${process.env.SHOTS}/feedback-art.png` });
});
