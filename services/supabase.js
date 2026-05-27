/**
 * REMOVED: direct Supabase access from the extension.
 *
 * All database queries are now routed over the WebSocket bridge to the Orca
 * desktop app, which runs them with the install's own credentials and
 * owner_email filtering. The extension holds no Supabase credentials.
 *
 * The orcaSupabase global that background.js previously used is no longer
 * populated here; background.js now calls sendQueryToDesktop() instead.
 */
