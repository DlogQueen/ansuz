import 'dotenv/config';
import { getServiceClient } from '../src/lib/supabaseClient.js';

async function main() {
  const client = getServiceClient();

  const [shortTerm, longTerm] = await Promise.all([
    client.from('short_term_memory').select('*', { count: 'exact', head: true }),
    client.from('long_term_memory').select('*', { count: 'exact', head: true }),
  ]);

  if (shortTerm.error) {
    console.error('short_term_memory check failed:', shortTerm.error.message);
    process.exitCode = 1;
    return;
  }
  if (longTerm.error) {
    console.error('long_term_memory check failed:', longTerm.error.message);
    process.exitCode = 1;
    return;
  }

  console.log('Connected to Supabase.');
  console.log(`  short_term_memory rows: ${shortTerm.count}`);
  console.log(`  long_term_memory rows:  ${longTerm.count}`);
}

main().catch((err) => {
  console.error('Connection check failed:', err.message ?? err);
  process.exitCode = 1;
});
