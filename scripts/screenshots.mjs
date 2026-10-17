// Regenerates the README screenshots into docs/screenshots/ (starts its own Vite dev server).
// usage: npm run screenshots   (CHROMIUM_PATH overrides /usr/bin/chromium)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = 5199;
const OUT = 'docs/screenshots';
const SIZE = { width: 1200, height: 900 };
const SHOTS = {
  hero: 'view=three-quarter,pitch=14,zoom=0.85',
  side: 'view=side,yaw=0,pitch=8',
  spout: 'view=side,yaw=-70,pitch=15,zoom=2.4,tx=-0.05,ty=0.115',
  'lid-open': 'view=three-quarter,pitch=18,lid=1,zoom=0.7,ty=0.11',
  exploded: 'view=three-quarter,pitch=12,explode=1,zoom=0.5,ty=0.15',
};

mkdirSync(OUT, { recursive: true });
const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);

try {
  for (let i = 0; ; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {}
    if (i > 60) throw new Error('dev server did not start');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: SIZE });
  page.on('pageerror', (error) => console.error('pageerror:', error.message));
  for (const [name, query] of Object.entries(SHOTS)) {
    await page.goto(`http://127.0.0.1:${PORT}/?w=${SIZE.width}&h=${SIZE.height}&${query.replace(/,/g, '&')}`);
    await page.waitForFunction(() => window.__MOKA_READY === true, null, { timeout: 120000 });
    await page.waitForTimeout(500);
    await page.locator('canvas').screenshot({ path: `${OUT}/${name}.png` });
    console.log(`${OUT}/${name}.png`);
  }
  await browser.close();
} finally {
  stop();
}
