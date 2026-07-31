const { defineConfig, devices } = require('@playwright/test');
const fs = require('fs');

const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const launchOptions = process.platform === 'win32' && fs.existsSync(localChrome)
  ? { executablePath: localChrome }
  : undefined;

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false, // run sequentially to avoid indexDB/localStorage collisons in simulated syncs
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // keep to 1 worker so localStorage and DB state doesn't interfere
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    {
      name: 'iphone-13-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'iphone-11-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 414, height: 896 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'node node_modules/serve/build/main.js . -p 8000 --no-clipboard',
    url: 'http://localhost:8000',
    reuseExistingServer: true,
    timeout: 10000,
    env: { ...process.env, NO_UPDATE_CHECK: '1' },
  },
});
