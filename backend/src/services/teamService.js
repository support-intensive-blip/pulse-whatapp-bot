const { getDatabase } = require('../database/db');

class TeamService {
  findById(id) {
    if (!id) return null;
    return getDatabase().prepare('SELECT * FROM teams WHERE id = ?').get(id) || null;
  }

  list({ includeInactive = true } = {}) {
    return getDatabase()
      .prepare(`SELECT * FROM teams ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY id ASC`)
      .all();
  }

  /** Teams with the counts the owner's Teams table shows. */
  listWithStats() {
    return getDatabase()
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM bot_accounts b WHERE b.team_id = t.id AND b.is_active = 1) AS bot_count,
                (SELECT COUNT(*) FROM dashboard_users u WHERE u.team_id = t.id AND u.is_active = 1) AS user_count,
                (SELECT GROUP_CONCAT(u.name, ', ') FROM dashboard_users u
                   WHERE u.team_id = t.id AND u.role = 'team_admin' AND u.is_active = 1) AS admin_names
         FROM teams t
         ORDER BY t.id ASC`
      )
      .all();
  }

  create({ name, description = null, ownerUserId }) {
    const teamName = String(name || '').trim();
    if (!teamName) throw new Error('Team name is required');
    const result = getDatabase()
      .prepare(
        `INSERT INTO teams (name, description, owner_user_id, updated_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(teamName, description ? String(description).trim() : null, ownerUserId);
    return this.findById(result.lastInsertRowid);
  }

  update(id, { name, description, isActive } = {}) {
    const fields = ["updated_at = datetime('now')"];
    const values = [];
    if (name !== undefined) {
      if (!String(name).trim()) throw new Error('Team name cannot be empty');
      fields.push('name = ?');
      values.push(String(name).trim());
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description ? String(description).trim() : null);
    }
    if (isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(isActive ? 1 : 0);
    }
    values.push(id);
    getDatabase().prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  }

  toPublic(team) {
    if (!team) return null;
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      isActive: team.is_active !== 0,
      createdAt: team.created_at,
      updatedAt: team.updated_at,
      ...(team.bot_count !== undefined
        ? {
            botCount: team.bot_count,
            userCount: team.user_count,
            adminNames: team.admin_names || null,
          }
        : {}),
    };
  }
}

module.exports = { teamService: new TeamService() };
