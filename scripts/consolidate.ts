import 'dotenv/config';
import { consolidateMemory } from '../src/memory/consolidation.js';

/**
 * Manual/on-demand run of the consolidation job -- see src/memory/consolidation.ts.
 * scripts/server.ts also runs this on an interval while it's up; this script is
 * for running it standalone (e.g. right after a test session, without waiting).
 * `--force` ignores the idle-session check and consolidates everything now.
 */
async function main() {
  const force = process.argv.includes('--force');
  const result = await consolidateMemory({ force });
  console.log(
    `Consolidated ${result.sessionsConsolidated} session(s) (${result.entriesConsolidated} entries). ` +
      `${result.sessionsSkippedActive} session(s) skipped as still active, ` +
      `${result.sessionsFailed} failed (will retry next run).`
  );
}

main().catch((error) => {
  console.error('Consolidation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
