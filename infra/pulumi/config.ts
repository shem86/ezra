import * as pulumi from "@pulumi/pulumi";

// Typed view over the stack config. The same shape drives BOTH the adopt-prod
// stack (fields pinned to the live resources so `pulumi import` shows an empty
// diff) and any create-from-zero stack (defaults resolve a fresh box). Naming
// overrides exist precisely so import fidelity and clean creation coexist:
// AWS names like the SG groupName and the instance-profile name are immutable,
// so prod pins them to the existing values while a fresh env derives
// `hh-assistant-<envName>`.
export interface EnvConfig {
  envName: string;
  region: string;

  // compute
  instanceType: string;
  volumeSizeGb: number;
  ami?: string; // pin for adopt-prod; omit ⇒ latest Canonical Ubuntu 24.04 (SSM)
  keyName: string;
  instanceNameTag: string;

  // networking (pin for adopt-prod fidelity; omit ⇒ region default VPC/subnet)
  vpcId?: string;
  subnetId?: string;
  sshAllowCidr: string;
  securityGroupName: string;

  // iam (instance role/profile names — pin for adopt-prod)
  iamRoleName: string;
  instanceProfileName: string;

  // adopt-prod safety
  protectInstance: boolean;

  // optional per-env extras (off for a throwaway)
  createBackupBucket: boolean;
  backupBucketName?: string;
  createCiDeployRole: boolean;
  ciDeployRoleName?: string;
  githubRepo?: string; // owner/repo, for the OIDC trust subject

  // cloud-init full-chain bootstrap
  repoUrl: string;
  repoRef: string;
  ezraTag: string;

  // secrets delivery (see README — SSM is the testable default; SOPS+age is the
  // flagged portable alternative the plan recommended, confirm at review)
  secretsMode: "ssm" | "sops";
  secretsParam: string; // secretsMode=ssm: SSM SecureString holding the env's .env
  ageKeyParam?: string; // secretsMode=sops: SSM SecureString holding the SOPS age key
  sopsEnvFile?: string; // secretsMode=sops: repo-relative path to .env.<env>.enc
  deployKeyParam?: string; // SSM SecureString w/ a read-only repo deploy key (private-repo clone)

  // adopt-prod: maps a resource key (see host-environment.ts `imp`) to its live
  // AWS id. Present ⇒ that resource is brought into state via the `import`
  // resource option on the next `pulumi up`. Absent (a fresh env) ⇒ create.
  importIds?: Record<string, string>;
}

export function loadEnvConfig(): EnvConfig {
  const c = new pulumi.Config("ezra");
  const awsCfg = new pulumi.Config("aws");
  const envName = c.require("envName");
  return {
    envName,
    region: awsCfg.require("region"),

    instanceType: c.get("instanceType") ?? "t3a.medium",
    volumeSizeGb: c.getNumber("volumeSizeGb") ?? 40,
    ami: c.get("ami"),
    keyName: c.get("keyName") ?? "hh-assistant",
    instanceNameTag: c.get("instanceNameTag") ?? `hh-assistant-${envName}`,

    vpcId: c.get("vpcId"),
    subnetId: c.get("subnetId"),
    sshAllowCidr: c.get("sshAllowCidr") ?? "0.0.0.0/0",
    securityGroupName: c.get("securityGroupName") ?? `hh-assistant-${envName}-ssh`,

    iamRoleName: c.get("iamRoleName") ?? `hh-assistant-${envName}-ec2`,
    instanceProfileName: c.get("instanceProfileName") ?? `hh-assistant-${envName}-ec2`,

    protectInstance: c.getBoolean("protectInstance") ?? false,

    createBackupBucket: c.getBoolean("createBackupBucket") ?? false,
    backupBucketName: c.get("backupBucketName"),
    createCiDeployRole: c.getBoolean("createCiDeployRole") ?? false,
    ciDeployRoleName: c.get("ciDeployRoleName"),
    githubRepo: c.get("githubRepo"),

    repoUrl: c.get("repoUrl") ?? "https://github.com/shem86/hh-assistant.git",
    repoRef: c.get("repoRef") ?? "main",
    ezraTag: c.get("ezraTag") ?? "latest",

    secretsMode: (c.get("secretsMode") as "ssm" | "sops" | undefined) ?? "ssm",
    secretsParam: c.get("secretsParam") ?? "/hh-assistant/env",
    ageKeyParam: c.get("ageKeyParam"),
    sopsEnvFile: c.get("sopsEnvFile"),
    deployKeyParam: c.get("deployKeyParam"),

    importIds: c.getObject<Record<string, string>>("importIds"),
  };
}
