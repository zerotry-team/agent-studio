-- 同一企業・同一stageへ二重にAWSアカウントを払い出さない。
-- 失効後の再作成だけを許可する。
CREATE UNIQUE INDEX "runtimes_one_managed_stage_per_org_idx"
  ON "runtimes"("organization_id", "stage")
  WHERE "provisioning_type" = 'studio_managed' AND "status" <> 'revoked';
