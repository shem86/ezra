import { loadEnvConfig } from "./config";
import { HostEnvironment } from "./components/host-environment";
import { BackupBucket } from "./components/backup-bucket";
import { CiDeployRole } from "./components/ci-deploy-role";

// Entry point. The stack config (Pulumi.<stack>.yaml) decides whether this is the
// adopt-prod stack (everything pinned + protected, brought into state via
// `pulumi import` — see import-prod.sh) or a create-from-zero stack (defaults
// resolve a fresh box — the reproducibility capability).
const cfg = loadEnvConfig();

const host = new HostEnvironment(cfg);

// Optional, prod-shaped extras (a throwaway leaves both off).
if (cfg.createBackupBucket && cfg.backupBucketName) {
  new BackupBucket({
    envName: cfg.envName,
    bucketName: cfg.backupBucketName,
    importIds: cfg.importIds,
  });
}
if (cfg.createCiDeployRole && cfg.ciDeployRoleName && cfg.githubRepo) {
  new CiDeployRole({
    envName: cfg.envName,
    roleName: cfg.ciDeployRoleName,
    githubRepo: cfg.githubRepo,
    instanceId: host.instanceId,
    importIds: cfg.importIds,
  });
}

export const instanceId = host.instanceId;
export const publicIp = host.publicIp;
export const instanceRoleArn = host.instanceRoleArn;
