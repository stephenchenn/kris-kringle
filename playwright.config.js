const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');

module.exports = defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || (fs.existsSync('/usr/bin/google-chrome') ? 'chrome' : undefined),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
