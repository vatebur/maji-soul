import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAutomation as runContinuousAutomation, type AutomationDriver } from '../src/app/console/automation-loop.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import type { LiveAcceptanceOptions } from '../src/app/live.ts';
import { waitForLiveOpening } from '../src/app/console/opening.ts';

/** Tests explicitly issue the same stop command as an operator. Production has
 * no match count or run-duration limit. Legacy fixture bounds only schedule it. */
export async function runAutomation(page: EgoPagePort, runtime: string, options: LiveAcceptanceOptions, directory: string,
  finish: { maxMatches: number; maxDurationMs: number }, driver: AutomationDriver) {
  let completed = 0;
  const started = Date.now();
  return runContinuousAutomation(page, runtime, options, directory, { ...driver,
    opening: driver.opening??((page,game,signal,call)=>waitForLiveOpening(page,game,signal,call,60_000,async()=>true)),
    accept: async (...args) => {
      const report = await driver.accept(...args);
      if (report.lifecycle?.matchStatus === 'finished' &&
          (report.status === 'passed' || report.matchCompletion?.canStartNextMatch && report.matchCompletion.unresolvedAttempts === 0 && report.matchCompletion.gameMatchKey === report.gameMatchKey)) {
        completed++;
        if (completed >= finish.maxMatches || Date.now() - started >= finish.maxDurationMs)
          await writeFile(join(directory, 'control.json'), '{"enabled":false}');
      }
      return report;
    },
  });
}
