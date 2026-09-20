import type { EnvironmentName } from "./context";

export interface ReleaseMetadata {
  readonly application: string;
  readonly environment: EnvironmentName;
  readonly gitSha: string;
}
