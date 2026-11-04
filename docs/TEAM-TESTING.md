# Team testing bot

Every team has one dedicated testing bot with no WhatsApp phone number, provider credentials or outbound transport.
It is provisioned at team creation and for existing teams during startup. It is excluded from WhatsApp bot lists and connection counts.

The platform owner enables or disables the team's entitlement under Teams → Enable/Disable testing bot.
Teams start with access disabled until the owner enables it. Disabling preserves settings and conversations.
Owners can configure the bot for a selected team even before enabling access for that team.

After access is enabled, a team admin opens Testing bot in the sidebar. They can rename it, set the assistant name
and context window, paste/upload a system prompt, upload knowledge or select existing team knowledge documents.
Prompt uploads accept TXT/Markdown. Knowledge accepts PDF/TXT/Markdown/CSV/JSON using the existing browser extraction flow.
The prompt must be saved before testing. Configuration saves are versioned/audited where applicable.

Only owners and team admins can edit configuration. Admins can grant selected active team users chat access.
Shared users cannot edit prompts, knowledge, configuration or sharing, and do not receive prompt diagnostics.
All users have independent test conversation sessions. Removing a user from sharing, moving them to another team,
deactivating them or disabling the team's entitlement prevents further access on the next API request.

Test calls use the existing playground/AI/knowledge pipeline and are attributed to the testing bot and team with
environment=test. No WhatsApp sends or provider connections are created. There is no public anonymous sharing link.

Data fields: teams.testing_bot_enabled; bot_accounts.testing_team_id (unique), testing_shared_users (JSON array).
The provider label testing is internal and cannot be selected via normal WhatsApp credential APIs.
Internal profile/user identifiers use team-test-<botId>; they are not fake mobile numbers.

Endpoints:
- PUT /api/teams/:teamId/testing-access — owner entitlement control.
- GET /api/team-testing — accessible bot metadata; admin-only configuration payload.
- PUT /api/team-testing — admin configuration and selected-user sharing.
- POST /api/team-testing/knowledge — admin document upload/link.
- POST /api/team-testing/playground — authorised private test conversation.

Validation: run node scripts/test-team-testing.js in backend. It uses in-memory SQLite and mocked AI,
checks API authorisation, team isolation, singleton enforcement, knowledge upload, private sessions and test token attribution.
