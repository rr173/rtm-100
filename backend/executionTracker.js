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

function ensureContractExists(contractId) {
  const contract = queryOne('SELECT id FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    const err = new Error('合同不存在');
    err.status = 404;
    throw err;
  }
}

function createExecutionPlan(contractId, planData) {
  const { effective_date, deadlines } = planData;

  if (!effective_date || !Array.isArray(deadlines) || deadlines.length === 0) {
    throw new Error('effective_date和deadlines为必填项');
  }

  ensureContractExists(contractId);

  const existingClauses = queryAll(
    'SELECT clause_id FROM clauses WHERE contract_id = ?',
    [contractId]
  );
  const existingClauseIds = new Set(existingClauses.map(c => c.clause_id));

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
    if (!existingClauseIds.has(dl.clause_id)) {
      const err = new Error(`条款"${dl.clause_id}"不存在于该合同中`);
      err.status = 400;
      throw err;
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
  ensureContractExists(contractId);
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
  ensureContractExists(contractId);
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
  if (plan.status === 'waived') {
    const err = new Error('该条款已被豁免，不可标记为完成');
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

  ensureContractExists(contractId);
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
  if (plan.status === 'waived') {
    const err = new Error('该条款已被豁免，不可重复操作');
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
  ensureContractExists(contractId);
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
  ensureContractExists(contractId);
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
  ensureContractExists(contractId);
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

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidDateStr(dateStr) {
  if (typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = parseDate(dateStr);
  if (isNaN(d.getTime())) return false;
  return true;
}

function scanNotifications(date) {
  let scanDate;
  if (date === undefined || date === null) {
    scanDate = getTodayStr();
  } else {
    if (!isValidDateStr(date)) {
      const err = new Error('date格式必须为YYYY-MM-DD');
      err.status = 400;
      throw err;
    }
    scanDate = date;
  }
  const sevenDaysLater = addDays(scanDate, 7);

  const pendingPlans = queryAll(
    `SELECT ep.contract_id, ep.clause_id, ep.due_date, ep.responsible_party, c.title as contract_title, cl.title as clause_title
     FROM execution_plan ep
     JOIN contracts c ON ep.contract_id = c.id
     JOIN clauses cl ON ep.contract_id = cl.contract_id AND ep.clause_id = cl.clause_id
     WHERE ep.status = 'pending'`
  );

  let newNotifications = 0;
  let skippedDuplicates = 0;
  const scannedContractIds = new Set();

  for (const p of pendingPlans) {
    scannedContractIds.add(p.contract_id);
    const daysDiff = daysBetween(scanDate, p.due_date);

    let type = null;
    let days = 0;
    if (p.due_date < scanDate) {
      type = 'overdue';
      days = daysBetween(p.due_date, scanDate);
    } else if (p.due_date <= sevenDaysLater) {
      type = 'upcoming';
      days = daysDiff;
    }

    if (!type) continue;

    const clauseTitle = p.clause_title || p.clause_id;
    let message;
    if (type === 'upcoming') {
      message = `[${p.contract_title}] ${clauseTitle}(责任方:${p.responsible_party})将于${days}天后到期`;
    } else {
      message = `[${p.contract_title}] ${clauseTitle}(责任方:${p.responsible_party})已逾期${days}天`;
    }

    const existing = queryOne(
      `SELECT id FROM notifications 
       WHERE scan_date = ? AND contract_id = ? AND clause_id = ? AND type = ?`,
      [scanDate, p.contract_id, p.clause_id, type]
    );

    if (existing) {
      skippedDuplicates++;
      continue;
    }

    try {
      runSql(
        `INSERT INTO notifications 
         (contract_id, clause_id, type, due_date, responsible_party, message, is_read, scan_date)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [p.contract_id, p.clause_id, type, p.due_date, p.responsible_party, message, scanDate]
      );
      newNotifications++;
    } catch (e) {
      skippedDuplicates++;
    }
  }

  return {
    scanned_contracts: scannedContractIds.size,
    new_notifications: newNotifications,
    skipped_duplicates: skippedDuplicates
  };
}

function getNotifications(filters = {}) {
  const { party, type, contract_id, include_read } = filters;
  const conditions = [];
  const params = [];

  if (!include_read || include_read === 'false' || include_read === false) {
    conditions.push('n.is_read = 0');
  }
  if (party) {
    conditions.push('n.responsible_party = ?');
    params.push(party);
  }
  if (type) {
    conditions.push('n.type = ?');
    params.push(type);
  }
  if (contract_id) {
    conditions.push('n.contract_id = ?');
    params.push(contract_id);
  }
  conditions.push("ep.status = 'pending'");

  const where = 'WHERE ' + conditions.join(' AND ');
  const rows = queryAll(
    `SELECT n.id, n.contract_id, n.clause_id, n.type, n.due_date, n.responsible_party, n.message, n.is_read, n.created_at
     FROM notifications n
     LEFT JOIN execution_plan ep ON n.contract_id = ep.contract_id AND n.clause_id = ep.clause_id
     ${where}
     ORDER BY n.created_at DESC`,
    params
  );

  return rows.map(r => ({ ...r, is_read: r.is_read === 1 }));
}

function getNotificationStats() {
  const totalUnread = queryOne(
    `SELECT COUNT(*) as cnt FROM notifications n
     LEFT JOIN execution_plan ep ON n.contract_id = ep.contract_id AND n.clause_id = ep.clause_id
     WHERE n.is_read = 0 AND ep.status = 'pending'`
  )?.cnt || 0;

  const byTypeRows = queryAll(
    `SELECT n.type, COUNT(*) as cnt FROM notifications n
     LEFT JOIN execution_plan ep ON n.contract_id = ep.contract_id AND n.clause_id = ep.clause_id
     WHERE n.is_read = 0 AND ep.status = 'pending' GROUP BY n.type`
  );
  const byType = { upcoming: 0, overdue: 0 };
  for (const r of byTypeRows) {
    byType[r.type] = r.cnt;
  }

  const byPartyRows = queryAll(
    `SELECT n.responsible_party, COUNT(*) as cnt FROM notifications n
     LEFT JOIN execution_plan ep ON n.contract_id = ep.contract_id AND n.clause_id = ep.clause_id
     WHERE n.is_read = 0 AND ep.status = 'pending' GROUP BY n.responsible_party`
  );
  const byParty = { '甲方': 0, '乙方': 0 };
  for (const r of byPartyRows) {
    byParty[r.responsible_party] = r.cnt;
  }

  return {
    total_unread: totalUnread,
    by_type: byType,
    by_party: byParty
  };
}

function markNotificationRead(id) {
  const existing = queryOne('SELECT id, is_read FROM notifications WHERE id = ?', [id]);
  if (!existing) {
    const err = new Error('通知不存在');
    err.status = 404;
    throw err;
  }
  if (existing.is_read === 1) {
    return { id, is_read: true, already_read: true };
  }
  runSql('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
  return { id, is_read: true, already_read: false };
}

function markAllRead(contractId) {
  if (contractId !== undefined && contractId !== null) {
    if (!Number.isInteger(contractId) || contractId <= 0) {
      const err = new Error('contract_id必须是正整数');
      err.status = 400;
      throw err;
    }
    const contract = queryOne('SELECT id FROM contracts WHERE id = ?', [contractId]);
    if (!contract) {
      const err = new Error('合同不存在');
      err.status = 404;
      throw err;
    }
    const result = runSql(
      'UPDATE notifications SET is_read = 1 WHERE contract_id = ? AND is_read = 0',
      [contractId]
    );
    return { marked: result.changes, contract_id: contractId };
  }
  const result = runSql('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
  return { marked: result.changes };
}

module.exports = {
  createExecutionPlan,
  getExecutionPlan,
  completeClause,
  waiveClause,
  getClauseHistory,
  getAlerts,
  getExecutionReport,
  seedExecutionPlan,
  scanNotifications,
  getNotifications,
  getNotificationStats,
  markNotificationRead,
  markAllRead
};
