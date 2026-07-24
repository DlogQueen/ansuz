import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { respond } from '../src/conversation/loop.js';

async function main() {
  const sessionId = randomUUID();
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`Ansuz conversation loop (session ${sessionId}). Type "exit" to quit.\n`);

  for (;;) {
    let message: string;
    try {
      message = await rl.question('you> ');
    } catch {
      break; // stdin closed (e.g. piped input ended, Ctrl+D)
    }
    if (message.trim().toLowerCase() === 'exit') break;
    if (!message.trim()) continue;

    try {
      const reply = await respond({ message, sessionId });
      console.log(`ansuz> ${reply}\n`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
    }
  }

  rl.close();
}

main();
