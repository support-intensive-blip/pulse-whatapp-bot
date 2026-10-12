const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { getDatabase } = require('../database/db');
const { botAccountService } = require('./botAccountService');
const { RESOURCE_SEPARATOR } = require('./kbSemanticChunker');
const logger = require('../utils/logger');

const MAX_RESOURCE_CHARS = 2_000_000;
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json'];

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Team-level knowledge documents. Their text lives in the DB (survives redeploys,
 * syncs to BigQuery); a bot's index is built from the resources it links to.
 * A resource with source_path mirrors a file shipped in the repo.
 */
class KnowledgeResourceService {
  findById(id) {
    return (
      getDatabase()
        .prepare('SELECT * FROM knowledge_resources WHERE id = ? AND deleted_at IS NULL')
        .get(id) || null
    );
  }

  list(teamId) {
    return getDatabase()
      .prepare(
        `SELECT id, team_id, title, kind, filename, source_path, content_hash, created_by,
                created_at, updated_at, LENGTH(content) AS length
         FROM knowledge_resources
         WHERE team_id = ? AND deleted_at IS NULL
         ORDER BY id ASC`
      )
      .all(teamId);
  }

  botsUsing(resourceId, teamId) {
    return botAccountService
      .listByTeam(teamId)
      .filter((bot) => botAccountService.parseKnowledgeResourceIds(bot).includes(Number(resourceId)));
  }

  validateContent(content) {
    const text = String(content || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error('The knowledge resource is empty');
    if (text.length > MAX_RESOURCE_CHARS) {
      throw new Error(`The knowledge resource is too large (max ${MAX_RESOURCE_CHARS.toLocaleString()} characters)`);
    }
    return text;
  }

  create({ teamId, title, kind = 'text', content, filename = null, sourcePath = null, createdBy = null }) {
    const name = String(title || '').trim();
    if (!name) throw new Error('Title is required');
    const text = this.validateContent(content);
    const result = getDatabase()
      .prepare(
        `INSERT INTO knowledge_resources (team_id, title, kind, content, filename, source_path, content_hash, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(teamId, name, kind, text, filename, sourcePath, hashText(text), createdBy);
    return this.findById(result.lastInsertRowid);
  }

  /** `detachFile`: a dashboard edit stops a file-backed resource from following the repo file. */
  update(id, { title, content, detachFile = false } = {}) {
    const fields = ["updated_at = datetime('now')"];
    const values = [];
    if (title !== undefined) {
      if (!String(title).trim()) throw new Error('Title cannot be empty');
      fields.push('title = ?');
      values.push(String(title).trim());
    }
    if (content !== undefined) {
      const text = this.validateContent(content);
      fields.push('content = ?', 'content_hash = ?');
      values.push(text, hashText(text));
      if (detachFile) fields.push('source_path = NULL');
    }
    values.push(id);
    getDatabase().prepare(`UPDATE knowledge_resources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  /** Soft delete + unlink from every bot. Returns the ids of bots that used it. */
  remove(id) {
    const resource = this.findById(id);
    if (!resource) return [];
    const affected = this.botsUsing(id, resource.team_id);
    for (const bot of affected) {
      const ids = botAccountService.parseKnowledgeResourceIds(bot).filter((rid) => rid !== Number(id));
      botAccountService.setKnowledgeResourceIds(bot.id, ids);
    }
    getDatabase()
      .prepare("UPDATE knowledge_resources SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(id);
    return affected.map((bot) => bot.id);
  }

  async extractText({ buffer, filename = '', mimetype = '' }) {
    const ext = path.extname(String(filename)).toLowerCase();
    if (ext === '.pdf' || String(mimetype).includes('pdf')) {
      const data = await pdfParse(buffer);
      return { kind: 'pdf', text: data.text || '' };
    }
    if (TEXT_EXTENSIONS.includes(ext) || String(mimetype).startsWith('text/')) {
      return { kind: 'text', text: buffer.toString('utf8') };
    }
    throw new Error('Upload a .txt, .md, .csv, .json or .pdf file');
  }

  /** Changes whenever the bot's linked resources or their content change; null if none. */
  fingerprintForBot(bot) {
    const ids = botAccountService.parseKnowledgeResourceIds(bot);
    if (!ids.length) return null;
    const rows = getDatabase()
      .prepare(
        `SELECT id, content_hash FROM knowledge_resources
         WHERE id IN (${ids.map(() => '?').join(',')}) AND team_id = ? AND deleted_at IS NULL`
      )
      .all(...ids, bot.team_id);
    const byId = new Map(rows.map((row) => [row.id, row.content_hash]));
    const parts = ids.filter((id) => byId.has(id)).map((id) => `${id}:${byId.get(id)}`);
    return parts.length ? hashText(parts.join('|')) : null;
  }

  /** Combined text + hash a bot's index is built from (resources in link order). */
  textForBot(bot) {
    const ids = botAccountService.parseKnowledgeResourceIds(bot);
    const texts = ids
      .map((id) => this.findById(id))
      .filter((resource) => resource && resource.team_id === bot.team_id && resource.content)
      .map((resource) => resource.content);
    const text = texts.join(RESOURCE_SEPARATOR);
    return { text, hash: text ? hashText(text) : null, resourceCount: texts.length };
  }

  /** Re-reads file-backed resources whose file changed (e.g. a redeploy with a new KB). */
  syncFileBackedResources() {
    const rows = getDatabase()
      .prepare('SELECT id, source_path, content_hash FROM knowledge_resources WHERE source_path IS NOT NULL AND deleted_at IS NULL')
      .all();
    const changed = [];
    for (const row of rows) {
      const filePath = path.resolve(row.source_path);
      if (!fs.existsSync(filePath) || path.extname(filePath).toLowerCase() === '.pdf') continue;
      try {
        const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
        if (text && hashText(text) !== row.content_hash) {
          this.update(row.id, { content: text });
          changed.push(row.id);
          logger.info(`Knowledge resource ${row.id} reloaded from ${row.source_path}`);
        }
      } catch (error) {
        logger.warn(`Knowledge resource ${row.id} file sync failed: ${error.message}`);
      }
    }
    return changed;
  }

  toPublic(resource, { usedBy = null } = {}) {
    if (!resource) return null;
    return {
      id: resource.id,
      teamId: resource.team_id,
      title: resource.title,
      kind: resource.kind,
      filename: resource.filename,
      fileBacked: Boolean(resource.source_path),
      length: resource.length ?? String(resource.content || '').length,
      createdAt: resource.created_at,
      updatedAt: resource.updated_at,
      ...(usedBy ? { usedBy } : {}),
    };
  }
}

module.exports = { knowledgeResourceService: new KnowledgeResourceService(), hashText };
