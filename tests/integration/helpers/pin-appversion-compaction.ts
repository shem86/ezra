// Same mechanism as pin-appversion-turn.ts, distinct value: the compaction
// suite launches its own DBOS and must not claim other files' pending
// workflows (or vice versa). Must be imported before '@dbos-inc/dbos-sdk'.
process.env.DBOS__APPVERSION = 'hh-compaction-v1';
