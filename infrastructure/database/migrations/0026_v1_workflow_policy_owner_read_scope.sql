-- V1 operational finance: narrow workflow-policy display-name lookup privileges.
-- This additive hardening keeps the function owner unable to read unrelated
-- user-account attributes while preserving immutable policy history labels.

REVOKE SELECT ON abos.user_accounts FROM abos_v1_workflow_policy_owner;
GRANT SELECT (id, display_name) ON abos.user_accounts
  TO abos_v1_workflow_policy_owner;
