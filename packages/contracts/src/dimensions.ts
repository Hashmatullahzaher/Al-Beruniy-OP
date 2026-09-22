import type { CostCenterId, DepartmentId, LegalEntityId, ProjectId } from "./ids.ts";

export type TransactionDimensions =
  | {
      readonly scope: "COMPANY_LEVEL";
      readonly legalEntityId: LegalEntityId;
      readonly companyLevelReason: "CORPORATE_CAPITAL" | "TREASURY" | "OTHER_APPROVED";
      readonly departmentId?: DepartmentId;
      readonly costCenterId?: CostCenterId;
    }
  | {
      readonly scope: "PROJECT_LEVEL";
      readonly legalEntityId: LegalEntityId;
      readonly projectId: ProjectId;
      readonly departmentId: DepartmentId;
      readonly costCenterId: CostCenterId;
    };
