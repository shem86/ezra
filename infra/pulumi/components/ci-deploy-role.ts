import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// The GitHub Actions OIDC deploy role (deploy.yml assumes it as AWS_DEPLOY_ROLE_ARN).
// It is a global CI concern, not per-host: prod ADOPTS the existing role + OIDC
// provider; a throwaway sets createCiDeployRole=false. Scoped to ssm:SendCommand
// on the instance + GetCommandInvocation, plus reading the GHCR PAT param (the
// CD path reads it host-side via the instance role, but the deploy role keeps a
// least-priv read for diagnostics/parity).
export interface CiDeployRoleArgs {
  envName: string;
  roleName: string;
  githubRepo: string; // "owner/repo"
  instanceId: pulumi.Input<string>;
  importIds?: Record<string, string>; // adopt-prod: resource key → live id
}

export class CiDeployRole extends pulumi.ComponentResource {
  public readonly roleArn: pulumi.Output<string>;

  constructor(args: CiDeployRoleArgs, opts?: pulumi.ComponentResourceOptions) {
    super("ezra:infra:CiDeployRole", `${args.envName}-ci-deploy`, {}, opts);
    const self = { parent: this };
    const tags = { Project: "hh-assistant", Env: args.envName, ManagedBy: "pulumi" };
    const imp = (key: string): pulumi.CustomResourceOptions =>
      args.importIds?.[key]
        ? { parent: this, import: args.importIds[key], protect: true } // adopted ⇒ destroy-proof
        : { parent: this };

    // One OIDC provider per account for GitHub. prod imports the existing one.
    const oidc = new aws.iam.OpenIdConnectProvider(`${args.envName}-github-oidc`, {
      url: "https://token.actions.githubusercontent.com",
      clientIdLists: ["sts.amazonaws.com"],
      // GitHub's OIDC thumbprint is no longer validated by STS, but the field is
      // required; this is the long-standing published value.
      thumbprintLists: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
      tags,
    }, imp("oidc"));

    const identity = pulumi.output(aws.getCallerIdentity({}, self));
    const region = pulumi.output(aws.getRegion({}, self));

    const role = new aws.iam.Role(`${args.envName}-deploy-role`, {
      name: args.roleName,
      description: "GitHub Actions OIDC role for SSM-driven CD (deploy.yml)",
      assumeRolePolicy: pulumi.all([oidc.arn]).apply(([oidcArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: oidcArn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
            StringLike: { "token.actions.githubusercontent.com:sub": `repo:${args.githubRepo}:*` },
          },
        }],
      })),
      tags,
    }, imp("deployRole"));

    new aws.iam.RolePolicy(`${args.envName}-deploy-ssm`, {
      name: "hh-deploy-ssm",
      role: role.id,
      policy: pulumi.all([identity, region, args.instanceId]).apply(([id, r, iid]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "SendDeployCommand",
            Effect: "Allow",
            Action: "ssm:SendCommand",
            Resource: [
              `arn:aws:ec2:${r.region}:${id.accountId}:instance/${iid}`,
              `arn:aws:ssm:${r.region}::document/AWS-RunShellScript`,
            ],
          },
          { Sid: "ReadCommandResult", Effect: "Allow", Action: "ssm:GetCommandInvocation", Resource: "*" },
        ],
      })),
    }, imp("deploySsm"));

    this.roleArn = role.arn;
    this.registerOutputs({ roleArn: this.roleArn });
  }
}
