// DBOS reads DBOS__APPVERSION at SDK import time, so this module must be
// imported before '@dbos-inc/dbos-sdk' anywhere in the process. The steps
// suite pins its own version (instead of the vitest-wide 'hh-spike-v1'):
// vitest runs test files in parallel processes and DBOS recovery claims ANY
// pending workflow with a matching version — under a shared version this
// file's launch could claim the spike's killed workflow (not registered
// here) and vice versa.
process.env.DBOS__APPVERSION = 'hh-steps-v1';
