// Runs a plan's actions and fixes common failures right here, in code, instead of
// asking the main AI to re-plan (which costs 3-5 seconds each time).
//
//   1. run the step
//   2. judge the result: Jev if configured (about 0.2 s), otherwise word rules
//   3. a fixed table picks the fix: retry, explore + retry, switch to `obtain`, the
//      plan's own fallback, or hand back to the main AI only when nothing else fits
import type { Body } from '../body/types.ts';
import type { Cause, JevRouter, StepVerdict } from './router.ts';

export type Action = { skill: string; args?: any; fallback?: Action[] };
export type RunResult = { results: string[]; failed: boolean; localFixes: number };

/** Code-only judgement, used without Jev or when Jev isn't sure. */
export function judgeByWords(result: string): StepVerdict {
  const r = result.toLowerCase();
  const failed = /^(error|unknown|no |can't|cannot|need|missing|couldn't|stopped while)|collected \d+\/\d+|kept failing|\d+ couldn't be placed/.test(r);
  const cause: Cause =
    /aborted|interrupted|did not fire|timeout|timed out/.test(r) ? 'interrupted' :
    /unknown /.test(r) ? 'unknown_name' :
    /tool|pickaxe/.test(r) ? 'missing_tool' :
    /missing|ingredient|need |no fuel|^no .* in inventory/.test(r) ? 'missing_ingredients' :
    /no path|reach|too long|stuck|can't see/.test(r) ? 'out_of_reach' :
    /no .*(within|nearby)|couldn't find|nothing there/.test(r) ? 'nothing_nearby' : 'other';
  if (!failed) return { status: 'ok', cause };
  return { status: /collected [1-9]|\d+ blocks placed|placed [1-9]|smelted [1-9]/.test(r) ? 'partial' : 'failed', cause };
}

/** The fix table: given what went wrong, what to run next (or null = ask the main AI). */
function fixFor(act: Action, v: StepVerdict, tries: number): Action[] | null {
  const a = act.args ?? {};
  if (act.fallback?.length && tries >= 1) return act.fallback;
  if (tries >= 2) return null;
  switch (v.cause) {
    case 'interrupted': return [act];
    case 'out_of_reach': return tries === 0 ? [act] : null;          // the planner skips blocks it couldn't reach
    case 'nothing_nearby': return a.nearby ? null : [{ skill: 'explore', args: { distance: 60 } }, act]; // chores stay close
    case 'missing_tool':
    case 'missing_ingredients':
      // craft/collect/smelt failing on materials: let `obtain` work out the whole chain.
      if (act.skill === 'craft' && a.item) return [{ skill: 'obtain', args: { item: a.item, count: a.count ?? 1 } }];
      if (act.skill === 'collect' && /^[a-z_]+$/.test(a.block ?? '') && !['log', 'wood', 'stone', 'dirt', 'leaves', 'sand'].includes(a.block))
        return [{ skill: 'obtain', args: { item: a.block, count: a.count ?? 1 } }];
      if (act.skill === 'build' && tries === 0) return [act];            // build tops materials up itself
      return null;
    default:
      // A build that placed most blocks: run it again on the same spot to finish it.
      if (act.skill === 'build' && v.status === 'partial' && tries === 0) return [act];
      return null;
  }
}

export async function runActions(body: Body, router: JevRouter | null, actions: Action[], signal: AbortSignal,
                                 log: (...a: any[]) => void): Promise<RunResult> {
  const results: string[] = [];
  let localFixes = 0;
  const queue: { act: Action; tries: number }[] = actions.map((act) => ({ act, tries: 0 }));

  while (queue.length) {
    const { act, tries } = queue.shift()!;
    let r = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      await body.waitIfPaused();
      const before = body.interruptCount();
      try { r = await body.runSkill(act.skill, act.args ?? {}, signal); }
      catch (e: any) { if (signal.aborted) throw e; r = `ERROR: ${e.message}`; }
      if (body.interruptCount() === before || !/^(ERROR|collected \d+\/)/.test(r)) break;
      log(`   (interrupted by a fight, retrying ${act.skill})`);
    }
    results.push(`${act.skill}(${JSON.stringify(act.args ?? {})}) -> ${r}`);
    log('  ', results.at(-1));

    // Judge. Words first: if they say it plainly worked, don't spend a Jev call.
    let v = judgeByWords(r);
    if (v.status !== 'ok' && router) {
      const t0 = Date.now();
      try {
        const j = await router.judgeStep(act.skill, act.args ?? {}, r);
        if (j.status !== 'unsure') v = j; else v = { ...v, cause: j.cause };
        log(`   Jev ${Date.now() - t0}ms: ${j.status} (${j.cause})`);
      } catch (e: any) { log(`   Jev failed (${e.message}); using word rules`); } // a failed call is never read as an answer
    }
    if (v.status === 'ok') continue;

    const fix = fixFor(act, v, tries);
    if (!fix) return { results, failed: true, localFixes };
    localFixes++;
    log(`   fixing locally (${v.cause}): ${fix.map((f) => f.skill).join(' + ')}`);
    queue.unshift(...fix.map((f) => ({ act: f, tries: f === act ? tries + 1 : (f.skill === act.skill ? tries + 1 : 0) })));
  }
  return { results, failed: false, localFixes };
}
