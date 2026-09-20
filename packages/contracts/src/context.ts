export type EnvironmentName = "development" | "staging" | "production";

export interface CompanyContext {
  readonly companyId: string;
  readonly legalEntityId: string;
  readonly displayName: string;
}

export interface ProjectContext {
  readonly projectId: string;
  readonly displayName: string;
}

export type ContextSelection<T> =
  | { readonly status: "unavailable"; readonly value: null }
  | { readonly status: "selected"; readonly value: T };

export interface WorkspaceContext {
  readonly company: ContextSelection<CompanyContext>;
  readonly project: ContextSelection<ProjectContext>;
}

export const emptyWorkspaceContext: WorkspaceContext = {
  company: { status: "unavailable", value: null },
  project: { status: "unavailable", value: null }
};
