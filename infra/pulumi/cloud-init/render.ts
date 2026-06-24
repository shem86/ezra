import * as fs from "fs";
import * as path from "path";
import { EnvConfig } from "../config";

// Render the cloud-init user-data from the template, substituting the per-env
// values. Placeholders are `@@NAME@@` so they never collide with the shell
// `${...}` interpolation inside the embedded bootstrap script.
//
// This runs ONLY on a genuinely fresh box. The adopt-prod instance carries
// `userData` in ignoreChanges (it is already provisioned), so re-rendering here
// never re-bootstraps prod.
export function renderUserData(cfg: EnvConfig): string {
  const tmpl = fs.readFileSync(path.join(__dirname, "user-data.yaml.tmpl"), "utf8");
  const subs: Record<string, string> = {
    REPO_URL: cfg.repoUrl,
    REPO_REF: cfg.repoRef,
    EZRA_TAG: cfg.ezraTag,
    AWS_REGION: cfg.region,
    SECRETS_MODE: cfg.secretsMode,
    SECRETS_PARAM: cfg.secretsParam,
    AGE_KEY_PARAM: cfg.ageKeyParam ?? "",
    SOPS_ENV_FILE: cfg.sopsEnvFile ?? "",
    DEPLOY_KEY_PARAM: cfg.deployKeyParam ?? "",
    TAILSCALE_AUTHKEY_PARAM: cfg.tailscaleAuthkeyParam ?? "",
  };
  return tmpl.replace(/@@(\w+)@@/g, (_m, k: string) => {
    if (!(k in subs)) throw new Error(`cloud-init template references unknown placeholder @@${k}@@`);
    return subs[k];
  });
}
