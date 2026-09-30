import type { LegalEntityId, UserAccountId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { hashPassword } from "@abos/identity";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import type { Harness } from "./harness.ts";
import { SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/**
 * Test-only password-session provisioning for disposable PostgreSQL suites.
 *
 * Synthetic-world personas intentionally have no password credential. Operational entry points
 * introduced by 0032 reject their developer sessions, so a test that exercises an operational
 * capability must explicitly give its persona a current credential and obtain a
 * PASSWORD_OPERATIONAL session. The value is never a real password and never leaves the disposable
 * database.
 */
export async function issueOperationalSession(
  source: Pick<Harness, "executor"> | SqlExecutor,
  userAccountId: string,
  legalEntityId: string
): Promise<{ readonly token: string; readonly sessionId: string }> {
  const database = "executor" in source ? source.executor : source;
  const expectedPasswordHash = await hashPassword(`Disposable operational credential ${userAccountId}`);
  await database.query(
    `INSERT INTO abos.user_credentials
       (user_account_id, password_hash, must_change_password, password_set_at,
        password_set_by_user_account_id)
     VALUES ($1,$2,false,clock_timestamp(),$1)
     ON CONFLICT (user_account_id) DO UPDATE
       SET password_hash=EXCLUDED.password_hash, must_change_password=false,
           password_set_at=clock_timestamp(), password_set_by_user_account_id=EXCLUDED.password_set_by_user_account_id`,
    [userAccountId, expectedPasswordHash]
  );
  const session = await new SandboxAuthenticator(
    database,
    SYNTHETIC_AUTH_CONFIGURATION
  ).issuePasswordSession({
    userAccountId: userAccountId as UserAccountId,
    legalEntityId: legalEntityId as LegalEntityId,
    expectedPasswordHash
  }, database);
  return { token: session.token, sessionId: session.sessionId };
}
