import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { EnvConfig } from "../config";
import { renderUserData } from "../cloud-init/render";

// The per-host environment: networking lookups, security group, the EC2 instance
// role/profile, the Elastic IP, and the instance itself (full-chain cloud-init).
//
// One parameterized component drives BOTH paths:
//   - adopt-prod: every field is pinned to the live resource (see Pulumi.prod.yaml)
//     and each resource carries an `import` id (cfg.importIds) so the next
//     `pulumi up` brings the existing IDs into state; `protectInstance` guards
//     the box and `preview` must then show no replacements.
//   - create-fresh: no importIds, defaults resolve a brand-new box (latest Ubuntu
//     AMI, region default subnet) — this is the reproducibility capability.
export class HostEnvironment extends pulumi.ComponentResource {
  public readonly instanceId: pulumi.Output<string>;
  public readonly publicIp: pulumi.Output<string>;
  public readonly instanceRoleArn: pulumi.Output<string>;
  public readonly instanceRoleName: pulumi.Output<string>;

  constructor(cfg: EnvConfig, opts?: pulumi.ComponentResourceOptions) {
    super("ezra:infra:HostEnvironment", cfg.envName, {}, opts);
    const self = { parent: this };
    const name = cfg.envName;
    const tags = { Project: "hh-assistant", Env: name, ManagedBy: "pulumi" };

    // Resource opts: parent + (on the adopt-prod stack) the `import` id for this
    // key. An adopted resource is also `protect`ed — a fresh `pulumi destroy`
    // must never nuke live prod (the backup bucket is the only DR copy, the EIP
    // is the stable address). Absent key ⇒ plain create (scratch is destroyable).
    // See Pulumi.prod.yaml `ezra:importIds`.
    const imp = (key: string): pulumi.CustomResourceOptions =>
      cfg.importIds?.[key]
        ? { parent: this, import: cfg.importIds[key], protect: true }
        : { parent: this };

    // --- networking: pin for adopt fidelity, else the region's default VPC ----
    const vpcId: pulumi.Output<string> = cfg.vpcId
      ? pulumi.output(cfg.vpcId)
      : pulumi.output(aws.ec2.getVpc({ default: true }, self)).id;

    const subnetId: pulumi.Output<string> = cfg.subnetId
      ? pulumi.output(cfg.subnetId)
      : vpcId.apply(async (id) => {
          const subnets = await aws.ec2.getSubnets(
            { filters: [
              { name: "vpc-id", values: [id] },
              { name: "default-for-az", values: ["true"] },
            ] },
            self,
          );
          if (subnets.ids.length === 0) throw new Error(`no default subnet in VPC ${id}`);
          return subnets.ids[0];
        });

    // --- AMI: pin for adopt, else latest Canonical Ubuntu 24.04 amd64 (SSM) ---
    const amiId: pulumi.Output<string> = cfg.ami
      ? pulumi.output(cfg.ami)
      : pulumi.output(
          aws.ssm.getParameter(
            { name: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" },
            self,
          ),
        ).value;

    // --- security group: SSH in, egress OPEN ---------------------------------
    // Egress stays open on purpose: the real allowlist is host nftables on the
    // docker egress bridge (infra/egress, src/ops/egress-allowlist.ts). SG egress
    // tightening is deferred (V2_NOTES §5). groupName is immutable ⇒ pinned for adopt.
    // description + rule shape match the live prod SG EXACTLY: the group
    // description is immutable (a mismatch forces replacement), and the live
    // rules carry no per-rule descriptions. Egress stays open here; real egress
    // is host nftables (V2_NOTES §5). Descriptions must be ASCII (AWS regex).
    const sg = new aws.ec2.SecurityGroup(`${name}-sg`, {
      name: cfg.securityGroupName,
      description: "hh-assistant: SSH only ingress",
      vpcId: vpcId,
      ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [cfg.sshAllowCidr] }],
      egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
      tags: { ...tags, Name: cfg.securityGroupName },
    }, imp("sg"));

    // --- instance IAM: role + profile + SSM core + S3-backup + param-read -----
    const role = new aws.iam.Role(`${name}-ec2-role`, {
      name: cfg.iamRoleName,
      description: "hh-assistant backup sidecar: least-priv S3 to the backups bucket (T45)",
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
      tags,
    }, imp("ec2Role"));

    // SSM agent + CD via AWS-RunShellScript (deploy.yml) need this managed policy.
    new aws.iam.RolePolicyAttachment(`${name}-ssm-core`, {
      role: role.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    }, imp("ssmCore"));

    // Read SSM secrets (the GHCR PAT, the env/.env or age key) — used by the
    // CD on-host script and the cloud-init secret fetch. KMS decrypt scoped to
    // the SSM service for SecureString reads.
    // Physical name matches the live prod inline policy (`hh-read-ghcr-param`)
    // so adopt imports in place (no rename). It covers all of /hh-assistant/*
    // (the GHCR PAT plus the env/age secret) — a broadening the operator
    // approves at the adopt preview if the live doc is narrower.
    new aws.iam.RolePolicy(`${name}-read-ssm`, {
      name: "hh-read-ghcr-param",
      role: role.id,
      policy: pulumi.output(aws.getCallerIdentity({}, self)).apply((id) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "ssm:GetParameter",
              Resource: `arn:aws:ssm:${cfg.region}:${id.accountId}:parameter/hh-assistant/*`,
            },
            {
              Effect: "Allow",
              Action: "kms:Decrypt",
              Resource: "*",
              Condition: { StringEquals: { "kms:ViaService": `ssm.${cfg.region}.amazonaws.com` } },
            },
          ],
        }),
      ),
    }, imp("readSsm"));

    // S3 backup access (PITR sidecar uses the instance role via IMDS, see
    // infra/backup). Scoped to the env's backup bucket when one is named.
    if (cfg.backupBucketName) {
      const bucket = cfg.backupBucketName;
      new aws.iam.RolePolicy(`${name}-backup-s3`, {
        name: "hh-backup-s3-rw", // matches the live prod inline policy name
        role: role.id,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Sid: "ListBucket", Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: `arn:aws:s3:::${bucket}` },
            { Sid: "RWObjects", Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource: `arn:aws:s3:::${bucket}/*` },
          ],
        }),
      }, imp("backupS3"));
    }

    const instanceProfile = new aws.iam.InstanceProfile(`${name}-ec2-profile`, {
      name: cfg.instanceProfileName,
      role: role.name,
      tags,
    }, imp("ec2Profile"));

    // --- the instance --------------------------------------------------------
    // ignoreChanges:[userData, ami] is load-bearing for BOTH paths:
    //  - adopt-prod: the box is already provisioned; never re-bootstrap or
    //    replace it on a userData/AMI drift (replacement = lose Baileys + pgdata).
    //  - create-fresh: userData still runs at creation; ignoreChanges only
    //    prevents later churn from re-resolving the latest AMI.
    const instance = new aws.ec2.Instance(`${name}-instance`, {
      ami: amiId,
      instanceType: cfg.instanceType,
      subnetId: subnetId,
      keyName: cfg.keyName,
      vpcSecurityGroupIds: [sg.id],
      iamInstanceProfile: instanceProfile.name,
      associatePublicIpAddress: true,
      metadataOptions: { httpTokens: "required", httpEndpoint: "enabled" }, // IMDSv2
      rootBlockDevice: {
        volumeSize: cfg.volumeSizeGb,
        volumeType: "gp3",
        iops: 3000,
        throughput: 125,
        encrypted: false,
      },
      userData: renderUserData(cfg),
      userDataReplaceOnChange: false,
      tags: { ...tags, Name: cfg.instanceNameTag },
    }, {
      parent: this,
      protect: cfg.protectInstance,
      ignoreChanges: ["userData", "ami"],
      ...(cfg.importIds?.instance ? { import: cfg.importIds.instance } : {}),
    });

    // --- Elastic IP ----------------------------------------------------------
    const eip = new aws.ec2.Eip(`${name}-eip`, {
      domain: "vpc",
      tags: { ...tags, Name: `hh-assistant-${name}` },
    }, imp("eip"));
    new aws.ec2.EipAssociation(`${name}-eip-assoc`, {
      instanceId: instance.id,
      allocationId: eip.id,
    }, imp("eipAssoc"));

    this.instanceId = instance.id;
    this.publicIp = eip.publicIp;
    this.instanceRoleArn = role.arn;
    this.instanceRoleName = role.name;
    this.registerOutputs({
      instanceId: this.instanceId,
      publicIp: this.publicIp,
    });
  }
}
