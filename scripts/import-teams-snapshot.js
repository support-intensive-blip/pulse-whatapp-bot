#!/usr/bin/env node
/**
 * One-off import of teams + dashboard users from a JSON snapshot.
 * Usage: node scripts/import-teams-snapshot.js path/to/snapshot.json
 */
const fs = require('fs');
const path = require('path');
const { getDatabase, initializeDatabase } = require('../src/database/db');

function main() {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    console.error('Usage: node scripts/import-teams-snapshot.js <snapshot.json>');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  initializeDatabase();
  const db = getDatabase();

  const importTeams = db.transaction(() => {
    for (const team of snapshot.teams || []) {
      db.prepare(
        `INSERT INTO teams (id, name, owner_user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           owner_user_id = excluded.owner_user_id,
           created_at = excluded.created_at`
      ).run(team.id, team.name, team.owner_user_id, team.created_at);
    }

    for (const user of snapshot.users || []) {
      if (user.id === 1) {
        db.prepare('UPDATE dashboard_users SET name = ?, team_id = ? WHERE id = 1').run(
          user.name,
          user.team_id
        );
        continue;
      }

      db.prepare(
        `INSERT INTO dashboard_users
          (id, email, password_hash, name, coach_phone, action_alert_phones, role, is_active, team_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           password_hash = excluded.password_hash,
           name = excluded.name,
           coach_phone = excluded.coach_phone,
           action_alert_phones = excluded.action_alert_phones,
           role = excluded.role,
           is_active = excluded.is_active,
           team_id = excluded.team_id,
           created_at = excluded.created_at`
      ).run(
        user.id,
        user.email,
        user.password_hash,
        user.name,
        user.coach_phone || null,
        user.action_alert_phones || null,
        user.role,
        user.is_active,
        user.team_id,
        user.created_at
      );
    }
  });

  importTeams();
  console.log(
    JSON.stringify({
      teams: db.prepare('SELECT id, name, owner_user_id FROM teams').all(),
      users: db.prepare('SELECT id, email, role, team_id FROM dashboard_users').all(),
    })
  );
}

main();
