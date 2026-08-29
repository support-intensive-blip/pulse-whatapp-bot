/**
 * Apply prompt-save timeout fixes on the deployed app tree.
 * Run: node deploy/patch-config-save.js /opt/whatsapp-ai-assistant
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();

function patch(file, replacements) {
  const full = path.join(root, file);
  let text = fs.readFileSync(full, 'utf8');
  for (const { from, to, label } of replacements) {
    if (!text.includes(from)) {
      throw new Error(`Patch failed (${label}): pattern not found in ${file}`);
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(full, text);
  console.log(`patched ${file}`);
}

patch('src/services/botConfigService.js', [
  {
    label: 'kbPathChanged declaration',
    from: `    const fields = ["updated_at = datetime('now')"];
    const values = [];
    const kbPathChanged = botSettings.knowledgeBasePath !== undefined;`,
    to: `    const fields = ["updated_at = datetime('now')"];
    const values = [];
    const normalizeKbPath = (value) => String(value || '').replace(/\\\\/g, '/').trim();
    const previousTeamKbPath = teamId
      ? normalizeKbPath(teamConfigService.findByTeamId(teamId)?.knowledge_base_path)
      : '';
    const previousBotKbPath = normalizeKbPath(bot.knowledge_base_path);
    const incomingTeamKbPath =
      teamSettings.knowledgeBasePath !== undefined
        ? normalizeKbPath(teamSettings.knowledgeBasePath)
        : null;
    const incomingBotKbPath =
      botSettings.knowledgeBasePath !== undefined
        ? normalizeKbPath(botSettings.knowledgeBasePath)
        : null;
    // Only re-index when the KB path value actually changes. Sending the same
    // path on every prompt save previously blocked the dashboard for minutes.
    const kbPathActuallyChanged =
      (incomingTeamKbPath !== null && incomingTeamKbPath !== previousTeamKbPath) ||
      (incomingBotKbPath !== null && incomingBotKbPath !== previousBotKbPath);`,
  },
  {
    label: 'kb initialize gate',
    from: `    if (kbPathChanged || teamSettings.knowledgeBasePath !== undefined) {
      await knowledgeBaseService.initialize(true, teamId);
    }`,
    to: `    if (kbPathActuallyChanged) {
      await knowledgeBaseService.initialize(true, teamId);
    }`,
  },
]);

patch('src/services/teamConfigService.js', [
  {
    label: 'prefer stored kb path',
    from: `  resolveEffectiveKbPath(teamId) {
    const latest = findLatestTeamKbPdf(teamId);
    if (latest) {
      const row = this.findByTeamId(teamId);
      const stored = (row?.knowledge_base_path || '').replace(/\\\\/g, '/');
      if (stored !== latest) {
        this.repairTeamKbPath(teamId);
      }
      return latest;
    }

    const row = this.findByTeamId(teamId);
    const stored = resolveTeamKbPath(row);
    if (stored) return stored;

    return defaultTeamKbPath(teamId);
  }`,
    to: `  resolveEffectiveKbPath(teamId) {
    const row = this.findByTeamId(teamId);
    const stored = resolveTeamKbPath(row);
    // Prefer an explicitly configured path (txt/pdf) over auto-picking the
    // newest PDF — that overwrite was forcing bad re-indexes on every save.
    if (stored) return stored;

    const latest = findLatestTeamKbPdf(teamId);
    if (latest) return latest;

    return defaultTeamKbPath(teamId);
  }`,
  },
]);

patch('dashboard/src/api/client.js', [
  {
    label: 'timeout message',
    from: `      throw new ApiError('Request timed out. Refresh the page or sign in again.', 408);`,
    to: `      throw new ApiError('Request timed out. Wait a moment and try again — you are still signed in.', 408);`,
  },
  {
    label: 'config update timeout',
    from: `  update: (body) => api('/config', { method: 'PATCH', body }),`,
    to: `  update: (body) => api('/config', { method: 'PATCH', body, timeoutMs: 60000 }),`,
  },
]);

console.log('All patches applied');
