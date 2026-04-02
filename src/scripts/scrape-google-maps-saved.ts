#!/usr/bin/env tsx
// @ts-nocheck — page.evaluate() callbacks run in browser context with DOM types
// that aren't available in this Node.js tsconfig.
/**
 * Scrapes Google Maps saved/starred places and lists.
 *
 * Usage:
 *   # First time: log in and save the browser profile
 *   tsx src/scripts/scrape-google-maps-saved.ts --login
 *
 *   # Subsequent runs: scrape using the saved profile
 *   tsx src/scripts/scrape-google-maps-saved.ts [--debug]
 *
 * Options:
 *   --login             Launch visible browser for manual Google login.
 *                       The session is saved to the profile directory.
 *   --profile <path>    Chrome profile directory (default:
 *                       groups/telegram_main/config/chrome-profile/)
 *   --debug             Save a screenshot after navigating to saved places
 *                       (groups/telegram_main/data/debug-screenshot.png)
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  '../..',
);
const DEFAULT_PROFILE_PATH = path.join(
  PROJECT_ROOT,
  'groups/telegram_main/config/chrome-profile',
);
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  'groups/telegram_main/data/google-maps-saved.json',
);
const DEBUG_SCREENSHOT_PATH = path.join(
  PROJECT_ROOT,
  'groups/telegram_main/data/debug-screenshot.png',
);

const MAPS_URL = 'https://www.google.com/maps';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SavedPlace {
  name: string;
  address: string | null;
  url: string | null;
  rating: number | null;
  category: string | null;
  note: string | null;
}

interface SavedList {
  name: string;
  url: string;
  placeCount: number | null;
  places: SavedPlace[];
}

interface ScrapeResult {
  scrapedAt: string;
  account: string | null;
  lists: SavedList[];
  totalPlaces: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const login = args.includes('--login');
  const debug = args.includes('--debug');

  let profilePath = DEFAULT_PROFILE_PATH;
  const profileIdx = args.indexOf('--profile');
  if (profileIdx !== -1 && args[profileIdx + 1]) {
    profilePath = path.resolve(args[profileIdx + 1]);
  }

  return { login, debug, profilePath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function launchWithProfile(
  profilePath: string,
  headless: boolean,
): Promise<BrowserContext> {
  fs.mkdirSync(profilePath, { recursive: true });
  return chromium.launchPersistentContext(profilePath, {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function checkLogin(page: Page): Promise<string | null> {
  // Navigate to Google's login endpoint directly — this reliably reveals
  // whether the saved browser profile actually has a valid session.
  await page.goto('https://accounts.google.com/ServiceLogin', {
    waitUntil: 'domcontentloaded',
  });
  // Give redirects plenty of time to settle (session restore can be slow)
  await page.waitForTimeout(8000);

  const url = page.url();

  // If we're still on the sign-in page, the session is invalid
  if (
    url.includes('/ServiceLogin') ||
    url.includes('/signin') ||
    url.includes('accounts.google.com/v3/signin') ||
    url.includes('consent.google.com')
  ) {
    return null;
  }

  // If we were redirected to myaccount.google.com or similar, we're logged in.
  // Try to extract account email/name from the page.
  try {
    // myaccount pages often show the email in a data attribute or heading
    const emailEl = page.locator(
      '[data-email], a[aria-label*="Google Account"]',
    );
    const email = await emailEl
      .first()
      .getAttribute('data-email', { timeout: 5000 });
    if (email) return email;

    const label = await emailEl
      .first()
      .getAttribute('aria-label', { timeout: 3000 });
    if (label) {
      const match = label.match(/\(([^)]+)\)/);
      return match ? match[1] : label.replace('Google Account: ', '');
    }
  } catch {
    // Not critical
  }

  // Now navigate to Maps so the rest of the flow starts from the right page
  await page.goto(MAPS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  return 'authenticated';
}

async function scrapeListIndex(
  page: Page,
  debug = false,
): Promise<{ name: string; url: string; count: string | null }[]> {
  // Navigate to Google Maps home first
  await page.goto(MAPS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Open the hamburger menu (three lines icon, top left)
  const menuButton = page
    .locator(
      'button[aria-label="Menu"], ' +
        'button[aria-label="Open menu"], ' +
        'button[jsaction*="hamburger"]',
    )
    .first();

  try {
    await menuButton.waitFor({ timeout: 10000 });
    await menuButton.click();
    console.log('Clicked hamburger menu');
    await page.waitForTimeout(1500);
  } catch {
    console.error('Could not find the hamburger menu button');
    if (debug) {
      fs.mkdirSync(path.dirname(DEBUG_SCREENSHOT_PATH), { recursive: true });
      await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true });
      console.log(
        `[debug] Screenshot saved (hamburger not found): ${DEBUG_SCREENSHOT_PATH}`,
      );
      console.log(`[debug] Page URL: ${page.url()}`);
    }
    return [];
  }

  // Click "Saved" in the menu
  try {
    await page
      .locator('div[role="menuitem"]')
      .filter({ hasText: 'Saved' })
      .click();
    console.log('Clicked Saved in menu');
  } catch {
    console.error('Could not find Saved option in the menu');
    if (debug) {
      fs.mkdirSync(path.dirname(DEBUG_SCREENSHOT_PATH), { recursive: true });
      await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true });
      console.log(
        `[debug] Screenshot saved (Saved option not found): ${DEBUG_SCREENSHOT_PATH}`,
      );
      console.log(`[debug] Page URL: ${page.url()}`);
    }
    return [];
  }

  await page.waitForTimeout(3000);

  // Wait for saved lists panel to load
  try {
    await page.waitForSelector('div[role="feed"], div[aria-label*="Saved"]', {
      timeout: 15000,
    });
  } catch {
    // Fallback: try waiting for any actionable list items
    await page.waitForTimeout(5000);
  }

  if (debug) {
    fs.mkdirSync(path.dirname(DEBUG_SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true });
    console.log(`[debug] Screenshot saved: ${DEBUG_SCREENSHOT_PATH}`);
    console.log(`[debug] Page URL: ${page.url()}`);
  }

  // Scroll the sidebar to load all lists
  const sidebar = page.locator('div[role="feed"]').first();
  if (await sidebar.isVisible().catch(() => false)) {
    for (let i = 0; i < 5; i++) {
      await sidebar.evaluate((el) => el.scrollBy(0, 500));
      await page.waitForTimeout(1000);
    }
  }

  // Extract list links.
  // Google Maps saved lists appear as links containing "/maps/placelists/list/"
  // or as clickable items in the feed.
  const lists = await page.evaluate(() => {
    const results: { name: string; url: string; count: string | null }[] = [];

    // Method 1: look for links to placelists
    const links = document.querySelectorAll(
      'a[href*="/maps/placelists/list/"]',
    );
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      // Get the text content — the list name is typically in an aria-label or text
      const nameEl =
        link.querySelector(
          '[class*="fontHeadlineSmall"], [class*="fontTitleSmall"]',
        ) ?? link;
      const name = nameEl?.textContent?.trim() ?? 'Unknown List';

      // Try to find place count text nearby
      const countEl = link.querySelector(
        '[class*="fontBodyMedium"], [class*="fontBodySmall"]',
      );
      const countText = countEl?.textContent?.trim() ?? null;

      if (!results.some((r) => r.url === href)) {
        results.push({ name, url: href, count: countText });
      }
    }

    // Method 2: if no placelist links found, look for the default lists
    // (Starred, Want to go, Favorites, etc.) which may use different URLs
    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/maps/"]');
      for (const link of allLinks) {
        const href = (link as HTMLAnchorElement).href;
        if (
          href.includes('/saved') ||
          href.includes('/contrib') ||
          href.includes('/placelists')
        ) {
          const text = link.textContent?.trim();
          if (text && text.length > 0 && text.length < 100) {
            results.push({ name: text, url: href, count: null });
          }
        }
      }
    }

    return results;
  });

  return lists;
}

async function scrapePlacesFromList(
  page: Page,
  listUrl: string,
): Promise<SavedPlace[]> {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Wait for place items to load
  try {
    await page.waitForSelector('div[role="feed"], div[role="article"]', {
      timeout: 10000,
    });
  } catch {
    await page.waitForTimeout(3000);
  }

  // Scroll to load all places
  const feed = page.locator('div[role="feed"]').first();
  if (await feed.isVisible().catch(() => false)) {
    let previousHeight = 0;
    for (let i = 0; i < 20; i++) {
      const currentHeight = await feed.evaluate((el) => {
        el.scrollBy(0, 800);
        return el.scrollHeight;
      });
      await page.waitForTimeout(1500);
      if (currentHeight === previousHeight) break;
      previousHeight = currentHeight;
    }
  }

  // Extract place data
  const places = await page.evaluate(() => {
    const results: {
      name: string;
      address: string | null;
      url: string | null;
      rating: number | null;
      category: string | null;
      note: string | null;
    }[] = [];

    // Places appear as links within the feed
    const placeLinks = document.querySelectorAll(
      'a[href*="/maps/place/"], div[role="article"]',
    );

    for (const item of placeLinks) {
      const anchor =
        item.tagName === 'A'
          ? (item as HTMLAnchorElement)
          : item.querySelector('a[href*="/maps/place/"]');
      const url = anchor ? (anchor as HTMLAnchorElement).href : null;

      // Name: typically the first prominent text or aria-label
      const nameEl =
        item.querySelector('[class*="fontHeadlineSmall"]') ??
        item.querySelector('[class*="fontTitleSmall"]') ??
        item.querySelector('h3') ??
        item.querySelector('[aria-label]');
      const name =
        nameEl?.textContent?.trim() ??
        (anchor as HTMLAnchorElement | null)?.getAttribute('aria-label') ??
        'Unknown';

      if (name === 'Unknown' && !url) continue;

      // Rating: look for aria-label containing stars
      let rating: number | null = null;
      const ratingEl = item.querySelector('[role="img"][aria-label*="star"]');
      if (ratingEl) {
        const match = ratingEl
          .getAttribute('aria-label')
          ?.match(/([\d.]+)\s*star/);
        if (match) rating = parseFloat(match[1]);
      }

      // Address and category from body text elements
      const bodyEls = item.querySelectorAll(
        '[class*="fontBodyMedium"], [class*="fontBodySmall"]',
      );
      let address: string | null = null;
      let category: string | null = null;
      for (const el of bodyEls) {
        const text = el.textContent?.trim();
        if (!text) continue;
        // Category tends to be short (e.g. "Restaurant", "Café")
        if (!category && text.length < 40 && !text.includes(',')) {
          category = text;
        }
        // Address tends to be longer and contains commas or numbers
        if (
          !address &&
          (text.includes(',') || /\d/.test(text)) &&
          text.length > 5
        ) {
          address = text;
        }
      }

      // Note: Google Maps allows notes on saved places
      const noteEl = item.querySelector('[class*="note"], [data-note]');
      const note = noteEl?.textContent?.trim() ?? null;

      // Deduplicate by URL
      if (url && results.some((r) => r.url === url)) continue;

      results.push({ name, address, url, rating, category, note });
    }

    return results;
  });

  return places;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

async function loginFlow(profilePath: string): Promise<void> {
  console.log(`Launching browser for login (profile: ${profilePath})`);
  console.log('Log into your Google account, then close the browser window.');

  const context = await launchWithProfile(profilePath, false);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(MAPS_URL, { waitUntil: 'domcontentloaded' });

  // Wait for user to close the browser
  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });

  console.log('Browser closed. Profile saved.');
}

// ---------------------------------------------------------------------------
// Scrape flow
// ---------------------------------------------------------------------------

async function scrapeFlow(profilePath: string, debug: boolean): Promise<void> {
  if (!fs.existsSync(profilePath)) {
    console.error(
      `ERROR: No browser profile found at ${profilePath}\n` +
        'Run with --login first to create a profile and sign in.',
    );
    process.exit(1);
  }

  console.log(`Using profile: ${profilePath}`);
  if (debug) console.log('[debug] Debug mode enabled');

  const context = await launchWithProfile(profilePath, true);

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // Check authentication
    console.log('Checking Google authentication...');
    const account = await checkLogin(page);
    if (!account) {
      console.error(
        '\nERROR: Google session has expired.\n' +
          'Run with --login to re-authenticate.',
      );
      process.exit(2);
    }
    console.log(`Authenticated as: ${account}`);

    // Scrape the saved lists index
    console.log('Scraping saved lists...');
    const listIndex = await scrapeListIndex(page, debug);
    console.log(`Found ${listIndex.length} lists`);

    if (listIndex.length === 0) {
      console.log(
        'No saved lists found. This may mean:\n' +
          '- Your account has no saved lists\n' +
          '- Google Maps UI changed and selectors need updating\n' +
          "- The page didn't fully load",
      );
    }

    // Scrape each list's places
    const lists: SavedList[] = [];
    let totalPlaces = 0;

    for (const item of listIndex) {
      console.log(`  Scraping: ${item.name}...`);
      const places = await scrapePlacesFromList(page, item.url);
      console.log(`    → ${places.length} places`);

      const countMatch = item.count?.match(/(\d+)/);
      lists.push({
        name: item.name,
        url: item.url,
        placeCount: countMatch ? parseInt(countMatch[1], 10) : places.length,
        places,
      });
      totalPlaces += places.length;
    }

    // Build output
    const result: ScrapeResult = {
      scrapedAt: new Date().toISOString(),
      account: account === 'authenticated' ? null : account,
      lists,
      totalPlaces,
    };

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\nDone. ${totalPlaces} places across ${lists.length} lists.`);
    console.log(`Output: ${OUTPUT_PATH}`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { login, debug, profilePath } = parseArgs();

  if (login) {
    await loginFlow(profilePath);
  } else {
    await scrapeFlow(profilePath, debug);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
