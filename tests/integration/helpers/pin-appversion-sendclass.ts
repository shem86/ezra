// Distinct DBOS__APPVERSION for the send-class recovery file, so parallel
// vitest processes can't claim each other's pending workflows. Must be
// imported before '@dbos-inc/dbos-sdk' anywhere in the process.
process.env.DBOS__APPVERSION = 'hh-sendclass-v1';
