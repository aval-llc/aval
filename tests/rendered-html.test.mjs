import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import './integration/module-hooks.mjs';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

// Render real page components with a resolved identity fixture. Authentication
// itself is tested separately; public identity headers are never credentials.
const seams = {
  '@/lib/api/with-session': 'export const withPageSession = async work => globalThis.__RENDER_IDENTITY__ ? work({}) : null;',
  '@/lib/integrations/session': 'export const getPageIdentity = async () => globalThis.__RENDER_IDENTITY__; ',
  '@/app/[locale]/navigation': 'export const useRouter = () => ({push(){}, replace(){}}); export const usePathname = () => "/en";',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier === './navigation' && context.parentURL?.includes('dashboard-client') ? '@/app/[locale]/navigation' : specifier;
    if (key in seams) return { url: 'render-fixture:' + key, shortCircuit: true };
    return next(['next/headers', 'next/server'].includes(specifier) ? specifier + '.js' : specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('render-fixture:')) return { format: 'module', source: seams[url.slice('render-fixture:'.length)], shortCircuit: true };
    return next(url, context);
  },
});
const { default: Home } = await import('../app/[locale]/page.tsx');
async function render(path = '/en', authenticated = true) {
  const url = new URL(path, 'https://aval.test');
  const locale = url.pathname.split('/')[1] || 'en';
  globalThis.__RENDER_IDENTITY__ = authenticated ? { source: 'password', displayName: 'Evan', email: 'render@example.test' } : null;
  const page = await Home({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) });
  const messages = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
  const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale, messages, timeZone: 'UTC' }, page));
  return new Response(html, { headers: { 'content-type': 'text/html' } });
}

test('redirects the unlocalized root to the default locale', async () => {
  const { default: middleware } = await import('../middleware.ts');
  const { NextRequest } = await import('next/server.js');
  const response = middleware(new NextRequest('https://aval.test/'));
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get('location')).pathname, '/en');
});

test("authenticated first render waits for saved onboarding state", async () => {
  const response = await render("/en");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(visibleMain(html), /onboarding-loading/);
  assert.match(visibleMain(html), /Getting your workspace ready/);
  assert.doesNotMatch(visibleMain(html), /data-workspace-mode|auth-gate/);
});

test("onboarding loading is localized in Spanish without English fallback", async () => {
  const response = await render("/es-mx");
  assert.equal(response.status, 200);
  const main = visibleMain(await response.text());
  assert.match(main, /Preparando tu espacio de trabajo/);
  assert.doesNotMatch(main, /Getting your workspace ready/);
});

test("ships Inter typography, an off-white Apple-grey palette, integrations, and durable storage", async () => {
  const [catalog, layout, css, packageJson, messagesEn] = await Promise.all([
    readFile(new URL("../lib/integrations/catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/[locale]/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../messages/en.json", import.meta.url), "utf8"),
  ]);

  assert.match(catalog, /WhatsApp Business/);
  assert.match(catalog, /Apple Messages/);
  assert.match(catalog, /QuickBooks Online/);
  assert.match(messagesEn, /Connect two upstream systems/);
  assert.match(layout, /localFont/);
  assert.match(layout, /InterVariable\.woff2/);
  assert.match(layout, /Property operations, connected/);
  assert.match(css, /--canvas:\s*#f5f5f7/i);
  assert.match(css, /--surface:\s*#ffffff/i);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../app/fonts/InterVariable.woff2", import.meta.url));
  await access(new URL("../drizzle/0000_brainy_squirrel_girl.sql", import.meta.url));
});


function visibleMain(html) {
  return html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
}

test("legacy sample and view URLs cannot bypass onboarding", async () => {
  for (const view of ["overview", "settings", "setup", "tasks", "connections", "calendar", "projects", "teams", "inbox", "documents", "reviewCenter", "infrastructure", "leasing", "accounting", "maintenance"]) {
    const response = await render(`/en?data=sample&view=${view}`);
    assert.equal(response.status, 200, view);
    const main = visibleMain(await response.text());
    assert.match(main, /onboarding-loading/, view);
    assert.doesNotMatch(main, /DEMO DATA|Exit demo|Demo workspace|Alex Morgan|fictional sample/i, view);
  }
});

test("anonymous visits and legacy demo links require sign-in", async () => {
  for (const path of ["/en", "/en?data=sample", "/en?data=sample&view=settings"]) {
    const response = await render(path, false);
    const html = await response.text();
    assert.match(html, /auth-gate/);
    assert.doesNotMatch(html, /data-workspace-mode="demo"|data-workspace-mode="live"/);
  }
});

// Returning-user workspace regressions run in integration/workspace-render.integration.mjs.
