-- Audit references must not outlive accounts/projects, even with async events.
UPDATE developer_moderation_audit SET actor_id=NULL,action_note='',build_hash=NULL,version=NULL
 WHERE actor_id IS NOT NULL AND actor_id NOT IN (SELECT discord_id FROM developer_accounts);
UPDATE developer_moderation_audit SET subject_id=NULL,action_note='',role_value=NULL
 WHERE subject_id IS NOT NULL AND subject_id NOT IN (SELECT discord_id FROM developer_accounts);
UPDATE developer_moderation_audit SET project_id=NULL,action_note='',build_hash=NULL,version=NULL
 WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM developer_projects);
-- Replacement is atomic in the shared migration transaction. Repeated startup
-- migrations remain idempotent; no table or account/project data is dropped.
ALTER TABLE developer_moderation_audit DROP CONSTRAINT IF EXISTS developer_audit_actor_account_fk;
ALTER TABLE developer_moderation_audit ADD CONSTRAINT developer_audit_actor_account_fk
 FOREIGN KEY(actor_id) REFERENCES developer_accounts(discord_id) ON DELETE SET NULL;
ALTER TABLE developer_moderation_audit DROP CONSTRAINT IF EXISTS developer_audit_subject_account_fk;
ALTER TABLE developer_moderation_audit ADD CONSTRAINT developer_audit_subject_account_fk
 FOREIGN KEY(subject_id) REFERENCES developer_accounts(discord_id) ON DELETE SET NULL;
ALTER TABLE developer_moderation_audit DROP CONSTRAINT IF EXISTS developer_audit_project_fk;
ALTER TABLE developer_moderation_audit ADD CONSTRAINT developer_audit_project_fk
 FOREIGN KEY(project_id) REFERENCES developer_projects(id) ON DELETE SET NULL;
-- PostgreSQL does not create indexes for referencing FK columns. These keep
-- scoped export/erasure and FK cleanup from scanning the entire journal/queue.
CREATE INDEX IF NOT EXISTS developer_audit_actor ON developer_moderation_audit(actor_id);
CREATE INDEX IF NOT EXISTS developer_audit_subject ON developer_moderation_audit(subject_id);
CREATE INDEX IF NOT EXISTS developer_audit_project ON developer_moderation_audit(project_id);
CREATE INDEX IF NOT EXISTS developer_reports_reporter ON developer_moderation_reports(reporter_id);
CREATE INDEX IF NOT EXISTS developer_reports_project ON developer_moderation_reports(project_id);
CREATE INDEX IF NOT EXISTS developer_submissions_owner ON developer_moderation_submissions(owner_id);
CREATE INDEX IF NOT EXISTS developer_submissions_project ON developer_moderation_submissions(project_id);
