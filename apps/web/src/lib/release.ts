import type { ReleaseMetadata } from "@abos/contracts";
import { publicEnvironment } from "./env";

export const releaseMetadata: ReleaseMetadata = {
  application: publicEnvironment.applicationName,
  environment: publicEnvironment.environment,
  gitSha: publicEnvironment.gitSha
};
