#!/usr/bin/env node
// Stand-in for `journalctl`. Prints two canned lines in short-iso format
// so readJournal can parse them. We honor `-n N` by clamping; everything
// else is ignored.
const args = process.argv.slice(2);
const nFlag = args.indexOf('-n');
const limit = nFlag >= 0 ? parseInt(args[nFlag + 1], 10) : 100;

const lines = [
  '2026-05-24T16:00:00+0000 ip-172-26-3-45 polybot-strategy-d[123]: [16:00:00] info  tick',
  '2026-05-24T16:00:02+0000 ip-172-26-3-45 polybot-strategy-d[123]: [16:00:02] info  tick',
];
for (const l of lines.slice(0, limit)) console.log(l);
