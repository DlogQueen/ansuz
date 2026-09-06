/**
 * Stitches the static site into one self-contained page, so the whole thing can
 * be previewed from a single file before a domain exists.
 *
 * This is a preview harness, not a second copy of the site: it inlines
 * site/assets/style.css unchanged and lifts each page's markup verbatim, then
 * turns internal links into section swaps. If the preview and the site ever
 * disagree, the site is right and this script has a bug.
 *
 *   npm run build:preview
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROUTES: { route: string; file: string; label: string }[] = [
  { route: '/', file: 'site/index.html', label: 'Home' },
  { route: '/receptionist', file: 'site/receptionist.html', label: 'Receptionist' },
  { route: '/crew', file: 'site/crew.html', label: 'Sales Crew' },
  { route: '/book', file: 'site/book.html', label: 'The Book' },
  { route: '/privacy', file: 'site/privacy.html', label: 'Privacy' },
  { route: '/sms-terms', file: 'site/sms-terms.html', label: 'SMS Terms' },
  { route: '/terms', file: 'site/terms.html', label: 'Terms' },
  { route: '/ai-disclosure', file: 'site/ai-disclosure.html', label: 'AI Disclosure' },
  { route: '/404', file: 'site/404.html', label: '404' },
];

function bodyOf(file: string): string {
  const html = readFileSync(resolve(ROOT, file), 'utf8');
  const m = /<body>([\s\S]*?)<\/body>/.exec(html);
  if (!m) throw new Error(`no <body> found in ${file}`);
  return m[1].trim();
}

const css = readFileSync(resolve(ROOT, 'site/assets/style.css'), 'utf8');

const pages = ROUTES.map(({ route, file }, i) => {
  const inner = bodyOf(file)
    // The favicon is a real file on the deployed site; there is nowhere to
    // serve it from inside a single page, so the brand mark carries it here.
    .replace(/\s*<link rel="icon"[^>]*>/g, '');
  return `<div class="pv-page" data-route="${route}"${i === 0 ? '' : ' hidden'}>\n${inner}\n</div>`;
}).join('\n\n');

const switcher = ROUTES.map(
  ({ route, label }, i) =>
    `  <button type="button" data-go="${route}"${i === 0 ? ' aria-current="true"' : ''}>${label}</button>`,
).join('\n');

const out = `<title>Byte Me Dev Studio</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
${css}

/* --- preview harness ------------------------------------------------------
   Not part of the deployed site. This bar exists only because a single page
   has no server to route between eight files. */
.pv-bar {
  position: sticky; top: 0; z-index: 50;
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 10px 16px;
  background: var(--ink); border-bottom: 1px solid var(--ink);
}
.pv-bar .pv-tag {
  font-family: "IBM Plex Mono", monospace; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ink-3); margin-right: 8px;
}
.pv-bar button {
  font-family: "IBM Plex Sans", sans-serif; font-size: 12.5px; font-weight: 500;
  padding: 5px 11px; border-radius: 3px; cursor: pointer;
  background: transparent; color: #B0BFC3; border: 1px solid #2B3A3F;
}
.pv-bar button:hover { color: #ECF2F2; border-color: #4A5F65; }
.pv-bar button[aria-current="true"] { background: #123430; border-color: #4FD0BF; color: #4FD0BF; }
.pv-page[hidden] { display: none !important; }
</style>

<nav class="pv-bar" aria-label="Preview pages">
  <span class="pv-tag">Preview</span>
${switcher}
</nav>

${pages}

<script>
(function () {
  var pages = document.querySelectorAll('.pv-page');
  var tabs = document.querySelectorAll('.pv-bar button');

  function show(route) {
    var found = false;
    pages.forEach(function (p) {
      var match = p.dataset.route === route;
      p.hidden = !match;
      if (match) found = true;
    });
    if (!found) return show('/404');
    tabs.forEach(function (t) {
      if (t.dataset.go === route) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { show(t.dataset.go); });
  });

  // Internal links route in-page; anchors and mailto: behave normally.
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) !== '/') return;
    e.preventDefault();
    show(href);
  });
})();
</script>
`;

mkdirSync(resolve(ROOT, 'site/.preview'), { recursive: true });
const target = resolve(ROOT, 'site/.preview/bytemedevstudio.html');
writeFileSync(target, out, 'utf8');
console.log(`built ${target} (${(out.length / 1024).toFixed(0)} KB, ${ROUTES.length} pages)`);
