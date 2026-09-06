/**
 * A throwaway listener for one thing: proving that a REAL Twilio-signed request
 * passes verifyTwilioSignature().
 *
 * Every other signature test in this repo builds the signature itself, which
 * means it proves our HMAC matches our own idea of the payload. That is not the
 * same as matching Twilio's. The failure mode if we are wrong is the worst one
 * in the system: every inbound message is rejected, so STOP never registers and
 * the crew keeps texting someone who asked it to stop.
 *
 * Deliberately has no Supabase, no LLM, and no database — it answers one
 * question and nothing else, so it can run anywhere with only TWILIO_AUTH_TOKEN.
 *
 *   npm run verify:twilio -- --public-url https://<tunnel-host>
 */
import { createServer, type IncomingMessage } from 'node:http';
import { config } from 'dotenv';
import { verifyTwilioSignature } from '../src/integrations/twilio.js';

config();

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number(argOf('port') ?? process.env.PORT ?? 8788);

/**
 * Twilio signs the URL it called, so this must be the public URL exactly as
 * Twilio sees it — scheme and host included. Behind a tunnel the request's own
 * Host header is the tunnel's, which is usually right, but a proxy that rewrites
 * it would produce a mismatch that looks like a bad token. Passing it
 * explicitly removes that ambiguity from the result.
 */
const PUBLIC_URL = (argOf('public-url') ?? process.env.BMDC_PUBLIC_URL ?? '').replace(/\/+$/, '');

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

let seen = 0;

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Twilio signature check listener. Point a Twilio webhook here with POST.\n');
    return;
  }

  const raw = await readBody(req);
  const body: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) body[k] = v;

  const signature = req.headers['x-twilio-signature'];
  const hostUrl = `https://${req.headers.host ?? 'unknown'}${req.url ?? ''}`;
  const url = PUBLIC_URL ? `${PUBLIC_URL}${req.url ?? ''}` : hostUrl;

  const ok = verifyTwilioSignature({
    signature: typeof signature === 'string' ? signature : undefined,
    url,
    body,
  });

  seen += 1;
  console.log(`\n──────── request ${seen} ────────`);
  console.log('url signed against :', url);
  if (PUBLIC_URL && hostUrl !== url) console.log('url from Host header:', hostUrl, '(differs)');
  console.log('signature header   :', signature ?? '(absent)');
  console.log('params             :', Object.keys(body).sort().join(', ') || '(none)');
  if (body.From) console.log('from               :', body.From);
  if (body.Body) console.log('text               :', JSON.stringify(body.Body));
  console.log(ok ? '\n  ✅ SIGNATURE VERIFIED — a real Twilio request passes our check' : '\n  ❌ REJECTED');

  if (!ok) {
    // The overwhelmingly common cause is a URL mismatch, not a wrong token, so
    // say that rather than letting it read as "the token is broken".
    console.log('     Most likely the signed URL differs from what Twilio called.');
    console.log('     Re-run with --public-url set to the exact webhook URL configured in the console.');
  }

  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  console.log(PUBLIC_URL ? `signing against ${PUBLIC_URL}` : 'no --public-url given; using each request\'s Host header');
  if (!process.env.TWILIO_AUTH_TOKEN) {
    console.log('\nWARNING: TWILIO_AUTH_TOKEN is not set. Every request will be rejected.');
  }
});
