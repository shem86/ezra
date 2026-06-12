// Same mechanism as pin-appversion.ts, distinct value: every test file that
// launches DBOS pins its own app version so parallel vitest processes can't
// claim each other's pending workflows. Must be imported before
// '@dbos-inc/dbos-sdk' anywhere in the process.
process.env.DBOS__APPVERSION = 'hh-park-v1';
