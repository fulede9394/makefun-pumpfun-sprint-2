// Burst rider: a pump.fun replay bot (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
// runBot drives the bot: one onBatch call per slot-batch, orders filled two
// slots later, deterministic for a fixed seed (the two grading runs must agree
// byte for byte on the action log).

import { runBot } from './vendor/makefun-bot.ts';
import { createBurstBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createBurstBot(DEFAULT_PARAMS));
