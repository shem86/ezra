// Production entry (T42, ledger #1). A FRESH executor id per process
// generation must exist BEFORE the DBOS SDK is imported anywhere (the SDK
// reads DBOS__VMID at import time — dbos.md), so this entry sets it and only
// then loads the composition. With a per-generation id, launch-time
// auto-recovery is a no-op (nothing pends under a brand-new executor) and
// the 4.19.x datasource-init race cannot fire; the stranded work of the
// previous generation is rescued explicitly by resumeStrandedWorkflows()
// after launch, when datasources are initialized.
//
// This is the one env WRITE in src/ — src/ops/config.ts stays the only
// module that READS the environment.
process.env.DBOS__VMID = `ezra-${Date.now().toString(36)}-${process.pid}`;

await import('./main.js');
