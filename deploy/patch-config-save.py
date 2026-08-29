from pathlib import Path
import re
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')

# --- botConfigService (in case copy already has it, skip if already patched)
bot = (root / 'src/services/botConfigService.py')
bot = root / 'src/services/botConfigService.js'
text = bot.read_text(encoding='utf-8')
if 'kbPathActuallyChanged' not in text:
    old = """    const fields = [\"updated_at = datetime('now')\"];
    const values = [];
    const kbPathChanged = botSettings.knowledgeBasePath !== undefined;"""
    new = """    const fields = [\"updated_at = datetime('now')\"];
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
    const kbPathActuallyChanged =
      (incomingTeamKbPath !== null && incomingTeamKbPath !== previousTeamKbPath) ||
      (incomingBotKbPath !== null && incomingBotKbPath !== previousBotKbPath);"""
    if old not in text:
        raise SystemExit('botConfigService: declaration block not found')
    text = text.replace(old, new, 1)
    old2 = """    if (kbPathChanged || teamSettings.knowledgeBasePath !== undefined) {
      await knowledgeBaseService.initialize(true, teamId);
    }"""
    new2 = """    if (kbPathActuallyChanged) {
      await knowledgeBaseService.initialize(true, teamId);
    }"""
    if old2 not in text:
        raise SystemExit('botConfigService: initialize gate not found')
    text = text.replace(old2, new2, 1)
    bot.write_text(text, encoding='utf-8')
    print('patched botConfigService')
else:
    print('botConfigService already patched')

# --- teamConfigService prefer stored path
team = root / 'src/services/teamConfigService.js'
text = team.read_text(encoding='utf-8')
old = """  resolveEffectiveKbPath(teamId) {
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
  }"""
new = """  resolveEffectiveKbPath(teamId) {
    const row = this.findByTeamId(teamId);
    const stored = resolveTeamKbPath(row);
    // Prefer explicitly configured path over auto-picking newest PDF.
    if (stored) return stored;

    const latest = findLatestTeamKbPdf(teamId);
    if (latest) return latest;

    return defaultTeamKbPath(teamId);
  }"""
# Source file uses single backslash in regex; match either
if 'Prefer explicitly configured path over auto-picking newest PDF' not in text:
  pattern = r"  resolveEffectiveKbPath\(teamId\) \{\n    const latest = findLatestTeamKbPdf\(teamId\);\n    if \(latest\) \{\n      const row = this\.findByTeamId\(teamId\);\n      const stored = \(row\?\.knowledge_base_path \|\| ''\)\.replace\(/\\+/g, '/'\);\n      if \(stored !== latest\) \{\n        this\.repairTeamKbPath\(teamId\);\n      \}\n      return latest;\n    \}\n\n    const row = this\.findByTeamId\(teamId\);\n    const stored = resolveTeamKbPath\(row\);\n    if \(stored\) return stored;\n\n    return defaultTeamKbPath\(teamId\);\n  \}"
  m = re.search(pattern, text)
  if not m:
      # try exact read around the function
      idx = text.find('resolveEffectiveKbPath(teamId)')
      print('TEAM SNIP:', repr(text[idx:idx+450]))
      raise SystemExit('teamConfigService: resolveEffectiveKbPath not matched')
  text = text[:m.start()] + new + text[m.end():]
  team.write_text(text, encoding='utf-8')
  print('patched teamConfigService')
else:
  print('teamConfigService already patched')

# --- client.js
client = root / 'dashboard/src/api/client.js'
text = client.read_text(encoding='utf-8')
changed = False
if "sign in again" in text:
  text = text.replace(
    "Request timed out. Refresh the page or sign in again.",
    "Request timed out. Wait a moment and try again — you are still signed in.",
  )
  changed = True
if "update: (body) => api('/config', { method: 'PATCH', body })," in text:
  text = text.replace(
    "update: (body) => api('/config', { method: 'PATCH', body }),",
    "update: (body) => api('/config', { method: 'PATCH', body, timeoutMs: 60000 }),",
  )
  changed = True
if changed:
  client.write_text(text, encoding='utf-8')
  print('patched client.js')
else:
  print('client.js already patched or patterns missing')

print('done')
