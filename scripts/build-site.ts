/**
 * Renders the legal documents in docs/legal/ into styled pages under site/.
 *
 * The markdown files are the single source of truth: fill in the bracketed
 * placeholders there, re-run this, and the published pages follow. Keeping two
 * copies of a privacy policy is how they end up disagreeing, which is exactly
 * the kind of disagreement a regulator reads out loud.
 *
 *   npm run build:site
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface LegalPage {
  source: string;
  out: string;
  path: string;
  nav: string;
  title: string;
  description: string;
}

/** Order here is the order of the pill nav on every legal page. */
const PAGES: LegalPage[] = [
  {
    source: 'docs/legal/privacy-policy.md',
    out: 'site/privacy.html',
    path: '/privacy',
    nav: 'Privacy Policy',
    title: 'Privacy Policy',
    description:
      'What personal information Byte Me Studios collects from callers, message recipients and customers, who we share it with, and how to get it deleted.',
  },
  {
    source: 'docs/legal/sms-terms.md',
    out: 'site/sms-terms.html',
    path: '/sms-terms',
    nav: 'SMS Terms',
    title: 'SMS Messaging Terms',
    description:
      'How Byte Me Studios handles SMS consent, opt-outs, message frequency and rates. Required reading before you receive a message from us.',
  },
  {
    source: 'docs/legal/terms-of-service.md',
    out: 'site/terms.html',
    path: '/terms',
    nav: 'Terms of Service',
    title: 'Terms of Service',
    description:
      'The terms governing Byte Me Studios products: the receptionist, the sales crew, and our publications.',
  },
  {
    source: 'docs/legal/ai-disclosure.md',
    out: 'site/ai-disclosure.html',
    path: '/ai-disclosure',
    nav: 'AI Disclosure',
    title: 'AI Disclosure',
    description:
      'How Byte Me Studios uses AI to talk to people, what it is required to admit, and what it is not allowed to decide on its own.',
  },
];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline markdown. Code spans are pulled out first and put back last, so a
 * `**` inside backticks stays literal text instead of turning into bold.
 */
function inline(src: string): string {
  const codes: string[] = [];
  let out = src.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `@@CODE${codes.length - 1}@@`;
  });

  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    const external = /^https?:/.test(href) && !href.includes('bytemedevstudio.com');
    const attrs = external ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${href}"${attrs}>${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Unfilled placeholders are made loud on purpose: a policy published with
  // "[LEGAL ENTITY]" still in it should look broken, not plausible.
  out = out.replace(/\[([A-Z][A-Z ]*)\]/g, '<mark class="ph">[$1]</mark>');

  return out.replace(/@@CODE(\d+)@@/g, (_m, i: string) => codes[Number(i)]);
}

const cells = (row: string): string[] =>
  row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Enough markdown for these documents, and nothing beyond it. */
function renderMarkdown(md: string): { html: string; title: string; updated: string } {
  const lines = md.split('\n');
  const out: string[] = [];
  let title = '';
  let updated = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(`<h3>${inline(line.slice(4).trim())}</h3>`);
      i += 1;
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`<h2>${inline(line.slice(3).trim())}</h2>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push('<hr class="soft">');
      i += 1;
      continue;
    }

    // Table: header row, delimiter row, then body until a non-pipe line.
    if (line.startsWith('|') && lines[i + 1]?.startsWith('|') && /^[|\s:-]+$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push('<div class="tw"><table><thead><tr>');
      out.push(head.map((c) => `<th>${inline(c)}</th>`).join(''));
      out.push('</tr></thead><tbody>');
      for (const row of body) {
        out.push(`<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      out.push('</tbody></table></div>');
      continue;
    }

    // Blockquote — used for the "this page is required" callouts.
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<div class="note amber"><p>${inline(buf.join(' ').trim())}</p></div>`);
      continue;
    }

    // Lists. Continuation lines are indented, so fold them into the item.
    if (/^(\s*)([-*]|\d+\.)\s+(.*)$/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>`);
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const buf = [m[3]];
        i += 1;
        while (
          i < lines.length &&
          /^\s+\S/.test(lines[i]) &&
          !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
        ) {
          buf.push(lines[i].trim());
          i += 1;
        }
        out.push(`<li>${inline(buf.join(' '))}</li>`);
        if (i < lines.length && !lines[i].trim()) {
          // A blank line ends the list unless the next content is another item.
          const next = lines.slice(i).find((l) => l.trim());
          if (!next || !/^(\s*)([-*]|\d+\.)\s+/.test(next)) break;
          i += 1;
        }
      }
      out.push(`</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or a block-level marker.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3} |> |\||---+$)/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    // An address/contact block is a run of short, unpunctuated lines where the
    // line breaks are the content. Prose in these documents wraps near 78
    // columns and ends its lines mid-sentence or with a period, so it joins
    // normally. The 64 leaves room for a sole proprietor's "<name>, doing
    // business as <trade name>" entity line, which is the longest of them.
    const isBlock =
      para.length > 1 && para.every((l) => l.length <= 64 && !l.endsWith('.'));
    const text = para.join(isBlock ? '\n' : ' ');
    if (!updated && /Last updated:/.test(text)) {
      updated = text;
      continue;
    }
    if (text) {
      const rendered = isBlock
        ? para.map((l) => inline(l)).join('<br>')
        : inline(text);
      out.push(`<p>${rendered}</p>`);
    }
  }

  return { html: out.join('\n'), title, updated };
}

function page(meta: LegalPage, body: string, updated: string): string {
  const nav = PAGES.map((p) => {
    const current = p.path === meta.path ? ' aria-current="page"' : '';
    return `      <a href="${p.path}"${current}>${p.nav}</a>`;
  }).join('\n');

  const cleaned = updated
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^Byte Me Studios\s*/, '')
    .trim();
  const stamp = cleaned ? ` · ${escapeHtml(cleaned)}` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title} — Byte Me Dev Studio</title>
<meta name="description" content="${meta.description}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>

<header class="site-head">
  <div class="wrap">
    <a class="brand" href="/"><span class="mark">BM</span> Byte Me Dev Studio</a>
    <nav class="site-nav">
      <a href="/receptionist">Receptionist</a>
      <a href="/crew">Sales Crew</a>
      <a href="/book">The Book</a>
      <a href="/privacy" aria-current="page">Legal</a>
    </nav>
  </div>
</header>

<main class="legal">
  <div class="wrap narrow">
    <h1>${meta.title}</h1>
    <p class="meta">Byte Me Studios${stamp}</p>

    <nav class="legal-nav" aria-label="Legal documents">
${nav}
    </nav>

    <div class="prose">
${body}
    </div>
  </div>
</main>

<footer class="site-foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/"><span class="mark">BM</span> Byte Me Dev Studio</a>
        <p style="margin:14px 0 0;max-width:38ch;">AI systems that touch real customers, with the limits written down.</p>
      </div>
      <div>
        <h5>Products</h5>
        <ul>
          <li><a href="/receptionist">The Receptionist</a></li>
          <li><a href="/crew">The Sales Crew</a></li>
          <li><a href="/book">Byte Me — the book</a></li>
        </ul>
      </div>
      <div>
        <h5>Legal</h5>
        <ul>
${PAGES.map((p) => `          <li><a href="${p.path}">${p.nav}</a></li>`).join('\n')}
        </ul>
      </div>
    </div>
    <p class="fine">© 2026 Byte Me Studios. All rights reserved.</p>
  </div>
</footer>

</body>
</html>
`;
}

function main(): void {
  const unfilled = new Map<string, Set<string>>();

  for (const meta of PAGES) {
    const md = readFileSync(resolve(ROOT, meta.source), 'utf8');
    const { html, title, updated } = renderMarkdown(md);
    const rendered = page({ ...meta, title: title || meta.title }, html, updated);
    writeFileSync(resolve(ROOT, meta.out), rendered, 'utf8');
    console.log(`built ${meta.out}`);

    const found = md.match(/\[[A-Z][A-Z ]*\]/g);
    if (found) unfilled.set(meta.source, new Set(found));
  }

  if (unfilled.size > 0) {
    console.log('\nPlaceholders still unfilled — these render as highlighted [BRACKETS] on the live page:');
    for (const [source, set] of unfilled) {
      console.log(`  ${source}: ${[...set].join(', ')}`);
    }
    console.log('\nFill them in docs/legal/ and re-run. Do not register A2P with these live.');
  }
}

main();
