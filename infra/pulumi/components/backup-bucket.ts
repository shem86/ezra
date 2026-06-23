import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// The PITR backup bucket (infra/backup, T17): versioned, public-access-blocked,
// TLS-only, with a lifecycle that expires WAL at 14d and ages base backups.
// prod ADOPTS the existing `hh-assistant-backups-001467466089`; a real new env
// would create its own. A throwaway sets createBackupBucket=false (no backups).
//
// NOTE: object-level encryption is client-side (age) per the backup design; the
// bucket also keeps SSE-S3 as defence in depth (default on new buckets).
export interface BackupBucketArgs {
  envName: string;
  bucketName: string;
  importIds?: Record<string, string>; // adopt-prod: resource key → live id
}

export class BackupBucket extends pulumi.ComponentResource {
  public readonly bucketName: pulumi.Output<string>;

  constructor(args: BackupBucketArgs, opts?: pulumi.ComponentResourceOptions) {
    super("ezra:infra:BackupBucket", `${args.envName}-backups`, {}, opts);
    const tags = { Project: "hh-assistant", Env: args.envName, ManagedBy: "pulumi" };
    const imp = (key: string): pulumi.CustomResourceOptions =>
      args.importIds?.[key]
        ? { parent: this, import: args.importIds[key], protect: true } // adopted ⇒ destroy-proof (DR bucket)
        : { parent: this };

    const bucket = new aws.s3.BucketV2(`${args.envName}-backup-bucket`, {
      bucket: args.bucketName,
      tags,
    }, imp("bucket"));

    new aws.s3.BucketVersioningV2(`${args.envName}-backup-versioning`, {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    }, imp("bucketVersioning"));

    new aws.s3.BucketPublicAccessBlock(`${args.envName}-backup-pab`, {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    }, imp("bucketPab"));

    // TLS-only bucket policy (deny non-HTTPS).
    new aws.s3.BucketPolicy(`${args.envName}-backup-tls-only`, {
      bucket: bucket.id,
      policy: bucket.arn.apply((arn) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "DenyInsecureTransport",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [arn, `${arn}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }],
      })),
    }, imp("bucketPolicy"));

    new aws.s3.BucketLifecycleConfigurationV2(`${args.envName}-backup-lifecycle`, {
      bucket: bucket.id,
      // Matches the live prod bucket exactly (T17): WAL 14d, base 35d, both with
      // 7d noncurrent-version expiry, plus an abort-incomplete-MPU sweep.
      rules: [
        { id: "expire-wal", status: "Enabled", filter: { prefix: "pitr/wal/" }, expiration: { days: 14 }, noncurrentVersionExpiration: { noncurrentDays: 7 } },
        { id: "expire-base", status: "Enabled", filter: { prefix: "pitr/base/" }, expiration: { days: 35 }, noncurrentVersionExpiration: { noncurrentDays: 7 } },
        { id: "abort-mpu", status: "Enabled", filter: { prefix: "" }, abortIncompleteMultipartUpload: { daysAfterInitiation: 7 } },
      ],
    }, imp("bucketLifecycle"));

    this.bucketName = bucket.bucket;
    this.registerOutputs({ bucketName: this.bucketName });
  }
}
