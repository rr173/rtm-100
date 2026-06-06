const { queryAll, queryOne, runSql } = require('./database');

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = parseDate(dateStr1);
  const d2 = parseDate(dateStr2);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((d2 - d1) / msPerDay);
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createExecutionPlan(contractId, planData) {
  const { effective_date, deadlines } = planData;

  if (!effective_date || !Array.isArray(deadlines) || deadlines.length === 0) {
    throw new Error('effective_date和deadlines为必填项');
  }

  for (const dl of deadlines) {
    if (!dl.clause_id || !dl.due_date || !dl.responsible_party) {
      throw new Error('每个deadline必须包含clause_id, due_date, responsible_party');
    }
    if (!['甲方', '乙方'].includes(dl.responsible_party)) {
      throw new Error('responsible_party必须是"甲方"或"乙方"');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dl.due_date)) {
      throw new Error('due_date格式必须为YYYY-MM-DD');
    }
  }

  const existing = queryOne(
    'SELECT COUNT(*) as cnt FROM execution_plan WHERE contract_id = ?',
    [contractId]
  );
  if (existing && existing.cnt > 0) {
    const err = new Error('该合同已存在履约计划');
    err.status = 409;
    throw err;
  }

  const result = [];
  for (const dl of deadlines) {
    runSql(
      `INSERT INTO execution_plan 
       (contract_id, clause_id, due_date, responsible_party, status, description, effective_date)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [contractId, dl.clause_id, dl.due_date, dl.responsible_party, dl.description || '', effective_date]
    );
    const row = queryOne('SELECT last_insert_rowid() as id');
    runSql(
      `INSERT INTO execution_history (contract_id, clause_id, action, operator, note)
       VALUES (?, ?, 'create', 'system', ?)`,
      [contractId, dl.clause_id, `创建履约计划，截止日期: ${dl.due_date}`]
    );
    result.push({
      id: row.id,
      clause_id: dl.clause_id,
      due_date: dl.due_date,
      responsible_party: dl.responsible_party,
      status: 'pending',
      description: dl.description || ''
    });
  }

  return result;
}

function getExecutionPlan(contractId) {
  const rows = queryAll(
    `SELECT clause_id, due_date, responsible_party, status, description, completed_at
     FROM execution_plan
     WHERE contract_id = ?
     ORDER BY due_date ASC`,
    [contractId]
  );
  return rows;
}

function completeClause(contractId, clauseId, operator = 'system') {
  const plan = queryOne(
    'SELECT * FROM execution_plan WHERE contract_id = ? AND clause_id = ?',
    [contractId, clauseId]
  );
  if (!plan) {
    const err = new Error('该条款的履约计划不存在');
    err.status = 404;
    throw err;
  }
  if (plan.status === 'completed') {
    const err = new Error('该条款已标记为完成，不可重复操作');
    err.status = 400;
    throw err;
  }

  runSql(
    `UPDATE execution_plan 
     SET status = 'completed', completed_at = datetime('now')
     WHERE contract_id = ? AND clause_id = ?`,
    [contractId, clauseId]
  );
  runSql(
    `INSERT INTO execution_history (contract_id, clause_id, action, operator, note)
     VALUES (?, ?, 'complete', ?, '条款已完成')`,
    [contractId, clauseId, operator]
  );

  return {
    clause_id: clauseId,
    status: 'completed',
    completed_at: new Date().toISOString()
  };
}

function waiveClause(contractId, clauseId, reason, operator = 'system') {
  if (!reason) {
    const err = new Error('豁免必须提供reason');
    err.status = 400;
    throw err;
  }

  const plan = queryOne(
    'SELECT * FROM execution_plan WHERE contract_id = ? AND clause_id = ?',
    [contractId, clauseId]
  );
  if (!plan) {
    const err = new Error('该条款的履约计划不存在');
    err.status = 404;
    throw err;
  }
  if (plan.status === 'completed') {
    const err = new Error('该条款已标记为完成，不可豁免');
    err.status = 400;
    throw err;
  }

  runSql(
    `UPDATE execution_plan 
     SET status = 'waived'
     WHERE contract_id = ? AND clause_id = ?`,
    [contractId, clauseId]
  );
  runSql(
    `INSERT INTO execution_history (contract_id, clause_id, action, operator, note)
     VALUES (?, ?, 'waive', ?, ?)`,
    [contractId, clauseId, operator, reason]
  );

  return {
    clause_id: clauseId,
    status: 'waived',
    reason: reason
  };
}

function getClauseHistory(contractId, clauseId) {
  const rows = queryAll(
    `SELECT created_at as time, operator, action, note
     FROM execution_history
     WHERE contract_id = ? AND clause_id = ?
     ORDER BY created_at ASC`,
    [contractId, clauseId]
  );
  return rows;
}

function getAlerts(contractId, date) {
  if (!date) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    date = `${y}-${m}-${d}`;
  }

  const plans = queryAll(
    `SELECT clause_id, due_date, responsible_party, status
     FROM execution_plan
     WHERE contract_id = ?`,
    [contractId]
  );

  const sevenDaysLater = addDays(date, 7);

  const overdue = [];
  const upcoming = [];
  let onTrackCount = 0;

  for (const p of plans) {
    if (p.status === 'pending') {
      if (p.due_date < date) {
        overdue.push({
          clause_id: p.clause_id,
          due_date: p.due_date,
          days_overdue: daysBetween(p.due_date, date),
          responsible_party: p.responsible_party
        });
      } else if (p.due_date <= sevenDaysLater) {
        upcoming.push({
          clause_id: p.clause_id,
          due_date: p.due_date,
          days_remaining: daysBetween(date, p.due_date),
          responsible_party: p.responsible_party
        });
      } else {
        onTrackCount++;
      }
    }
  }

  const total = plans.length;
  const completedCount = plans.filter(p => p.status === 'completed').length;
  const completionRate = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  return {
    overdue,
    upcoming,
    on_track_count: onTrackCount,
    completion_rate: completionRate
  };
}

function getExecutionReport(contractId) {
  const plans = queryAll(
    `SELECT clause_id, due_date, responsible_party, status, completed_at
     FROM execution_plan
     WHERE contract_id = ?
     ORDER BY due_date ASC`,
    [contractId]
  );

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;

  const total = plans.length;
  const completed = plans.filter(p => p.status === 'completed').length;
  const pending = plans.filter(p => p.status === 'pending').length;
  const waived = plans.filter(p => p.status === 'waived').length;
  const overdue = plans.filter(p => p.status === 'pending' && p.due_date < today).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const partySummary = {
    '甲方': { total: 0, completed: 0, overdue: 0 },
    '乙方': { total: 0, completed: 0, overdue: 0 }
  };

  for (const p of plans) {
    if (partySummary[p.responsible_party]) {
      partySummary[p.responsible_party].total++;
      if (p.status === 'completed') {
        partySummary[p.responsible_party].completed++;
      }
      if (p.status === 'pending' && p.due_date < today) {
        partySummary[p.responsible_party].overdue++;
      }
    }
  }

  const timeline = [];

  for (const p of plans) {
    timeline.push({
      date: p.due_date,
      event: `截止日期: ${p.clause_id}`,
      clause_id: p.clause_id
    });
  }

  const histories = queryAll(
    `SELECT clause_id, action, created_at, note
     FROM execution_history
     WHERE contract_id = ?
     ORDER BY created_at ASC`,
    [contractId]
  );

  for (const h of histories) {
    const datePart = h.created_at.split(' ')[0];
    let event = '';
    if (h.action === 'create') event = '创建履约计划';
    else if (h.action === 'complete') event = '条款完成';
    else if (h.action === 'waive') event = '条款豁免';
    else event = '更新';
    timeline.push({
      date: datePart,
      event: `${event}: ${h.clause_id}`,
      clause_id: h.clause_id
    });
  }

  timeline.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return 0;
  });

  return {
    total_clauses: total,
    completed,
    pending,
    waived,
    overdue,
    completion_rate: completionRate,
    party_summary: partySummary,
    timeline
  };
}

function seedExecutionPlan(contractId) {
  const existing = queryOne(
    'SELECT COUNT(*) as cnt FROM execution_plan WHERE contract_id = ?',
    [contractId]
  );
  if (existing && existing.cnt > 0) {
    return;
  }

  const now = new Date();
  const fmt = (offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const effectiveDate = fmt(-30);

  const deadlines = [
    {
      clause_id: 'C05',
      due_date: fmt(-10),
      responsible_party: '乙方',
      description: '确认责任上限条款执行，完成风险评估报告'
    },
    {
      clause_id: 'C07',
      due_date: fmt(3),
      responsible_party: '甲方',
      description: '收到发票后120天内完成服务费用支付'
    },
    {
      clause_id: 'C09',
      due_date: fmt(45),
      responsible_party: '甲方',
      description: '保密义务持续履行，定期检查信息安全措施'
    },
    {
      clause_id: 'C11',
      due_date: fmt(90),
      responsible_party: '乙方',
      description: '终止条款复核，确认提前通知期合规性'
    }
  ];

  for (const dl of deadlines) {
    runSql(
      `INSERT INTO execution_plan 
       (contract_id, clause_id, due_date, responsible_party, status, description, effective_date)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [contractId, dl.clause_id, dl.due_date, dl.responsible_party, dl.description, effectiveDate]
    );
    runSql(
      `INSERT INTO execution_history (contract_id, clause_id, action, operator, note)
       VALUES (?, ?, 'create', 'system', ?)`,
      [contractId, dl.clause_id, `创建履约计划，截止日期: ${dl.due_date}`]
    );
  }

  console.log('Seeded execution plan for demo contract (C05/C07/C09/C11).');
}

module.exports = {
  createExecutionPlan,
  getExecutionPlan,
  completeClause,
  waiveClause,
  getClauseHistory,
  getAlerts,
  getExecutionReport,
  seedExecutionPlan
};
