const { dashboardUserService } = require('./dashboardUserService');

function activeAssignee(id, teamId) {
  const user = id && dashboardUserService.findById(id);
  return user?.is_active && user.team_id === teamId ? user.id : null;
}

function normalizeRules(value, teamId) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Add up to 20 call-to-action categories.');
  const names = new Set();
  return value.map(row => {
    const category = String(row?.category || '').trim();
    const trigger = String(row?.trigger || '').trim();
    const key = category.toLowerCase();
    if (!category || category.length > 50 || names.has(key) || !trigger || trigger.length > 500) {
      throw new Error('Give each category a unique name and a trigger of up to 500 characters.');
    }
    names.add(key);
    const assigneeId = Number(row.assigneeId) || null;
    if (assigneeId && !activeAssignee(assigneeId, teamId)) {
      throw new Error('Select an active member of this team for each assigned category.');
    }
    return { category, trigger, assigneeId };
  });
}

function readRules(bot) {
  try {
    const rules = JSON.parse(bot?.action_category_rules || '[]');
    return Array.isArray(rules) ? rules : [];
  } catch {
    return [];
  }
}

module.exports = { normalizeRules, readRules, activeAssignee };
