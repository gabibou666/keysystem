-- Maintenance: purge des logs operationnels qui s'accumulent a l'infini.
-- DOCUMENTATION / execution manuelle uniquement.
-- SOURCE DE VERITE: src/services/purge.js (intervals + tables y sont definis).
-- Beacons et executions: 90j (fenetre investigation watermark alignee).
-- admin_sessions et robux_api_logs: 30j (cf purge.js).
DELETE FROM ll_sessions WHERE created_at < now() - interval '30 days';
DELETE FROM postbacks WHERE created_at < now() - interval '30 days';
DELETE FROM beacons WHERE created_at < now() - interval '90 days';
DELETE FROM error_reports WHERE created_at < now() - interval '30 days';
DELETE FROM robux_api_logs WHERE created_at < now() - interval '30 days';
DELETE FROM admin_sessions WHERE created_at < now() - interval '30 days';
DELETE FROM executions WHERE created_at < now() - interval '90 days';
DELETE FROM activations WHERE created_at < now() - interval '90 days';
