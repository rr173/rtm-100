const { queryAll, queryOne, runSql } = require('./database');
const { extractQuantities, SEVERITY_TO_RISK_LEVEL, getLowerPriorityClause } = require('./conflictDetection');

const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };

function evaluateCondition(condition, quantities) {
  try {
    const context = {};

    const amounts = quantities.filter(q => q.type === 'amount');
    const durations = quantities.filter(q => q.type === 'duration');
    const percentages = quantities.filter(q => q.type === 'percentage');

    if (amounts.length > 0) context.amount = amounts[0].value;
    if (amounts.length > 1) context.amount_max = Math.max(...amounts.map(a => a.value));
    if (amounts.length > 1) context.amount_min = Math.min(...amounts.map(a => a.value));

    if (durations.length > 0) context.duration = durations[0].value;
    if (durations.length > 1) context.duration_max = Math.max(...durations.map(d => d.value));
    if (durations.length > 1) context.duration_min = Math.min(...durations.map(d => d.value));

    if (percentages.length > 0) context.percentage = percentages[0].value;
    if (percentages.length > 1) context.percentage_max = Math.max(...percentages.map(p => p.value));
    if (percentages.length > 1) context.percentage_min = Math.min(...percentages.map(p => p.value));

    const keys = Object.keys(context);
    const values = Object.values(context);

    const fn = new Function(...keys, `return (${condition});`);
    return fn(...values);
  } catch {
    return false;
  }
}

function syncConflictDerivedRiskLevel(contractId, conflict, revision) {
  const targetClauseId = getLowerPriorityClause(conflict.clause_a_id, conflict.clause_b_id);
  const newRiskLevel = SEVERITY_TO_RISK_LEVEL[conflict.severity];

  const existing = queryOne(
    'SELECT id, level FROM risk_annotations WHERE contract_id = ? AND conflict_id = ? AND clause_id = ? AND revision = ?',
    [contractId, conflict.id, targetClauseId, revision]
  );

  if (!existing) {
    const triggerReason = `冲突派生风险: 条款"${conflict.clause_a_id}"与条款"${conflict.clause_b_id}"存在${conflict.conflict_type === 'contradiction' ? '矛盾' : '歧义/重叠'}冲突(冲突ID=${conflict.id}),严重等级:${conflict.severity}`;
    const result = runSql(
      'INSERT INTO risk_annotations (contract_id, clause_id, rule_id, conflict_id, level, trigger_reason, source, revision) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)',
      [contractId, targetClauseId, conflict.id, newRiskLevel, triggerReason, 'conflict', revision]
    );
    return { id: result.lastInsertRowid };
  } else if (existing.level !== newRiskLevel) {
    runSql(
      'UPDATE risk_annotations SET level = ? WHERE id = ?',
      [newRiskLevel, existing.id]
    );
    return { id: existing.id, level: newRiskLevel };
  }
  return existing;
}

function updateConflictSeveritiesFromRisks(contractId, revision) {
  const allRisks = queryAll(
    'SELECT DISTINCT clause_id FROM risk_annotations WHERE contract_id = ? AND revision = ? AND level = ?',
    [contractId, revision, 'high']
  );
  const highRiskClauseIds = new Set(allRisks.map(r => r.clause_id));

  const conflicts = queryAll(
    'SELECT * FROM detected_conflicts WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );

  const updated = [];
  for (const conflict of conflicts) {
    const hasHighRiskClause = highRiskClauseIds.has(conflict.clause_a_id) || highRiskClauseIds.has(conflict.clause_b_id);
    const originalSeverity = conflict.original_severity || conflict.severity;

    let newSeverity;
    if (hasHighRiskClause) {
      newSeverity = originalSeverity === 'critical' ? 'critical' : 'critical';
    } else {
      newSeverity = originalSeverity;
    }

    if (newSeverity !== conflict.severity) {
      runSql(
        'UPDATE detected_conflicts SET severity = ? WHERE id = ?',
        [newSeverity, conflict.id]
      );
      conflict.severity = newSeverity;
    }

    syncConflictDerivedRiskLevel(contractId, conflict, revision);
    updated.push(conflict);
  }

  return updated;
}

function annotateRisks(contractId, revision = 1, clausesInput = null) {
  const clauses = clausesInput || queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
  const riskRules = queryAll('SELECT * FROM risk_rules');

  runSql('DELETE FROM risk_annotations WHERE contract_id = ? AND revision = ? AND source = ?', [contractId, revision, 'rule']);

  const annotations = [];

  for (const clause of clauses) {
    const tags = JSON.parse(clause.tags);
    const quantities = extractQuantities(clause.body);

    for (const rule of riskRules) {
      const triggerTags = JSON.parse(rule.trigger_tags);
      const matches = triggerTags.some(t => tags.includes(t));

      if (!matches) continue;

      const condResult = evaluateCondition(rule.condition, quantities);

      if (condResult) {
        const reason = `条款"${clause.title}"匹配规则"${rule.description}",条件"${rule.condition}"满足,风险等级: ${rule.level}`;

        const result = runSql(
          'INSERT INTO risk_annotations (contract_id, clause_id, rule_id, conflict_id, level, trigger_reason, source, revision) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
          [contractId, clause.clause_id, rule.id, rule.level, reason, 'rule', revision]
        );

        annotations.push({
          id: result.lastInsertRowid,
          contract_id: contractId,
          clause_id: clause.clause_id,
          rule_id: rule.id,
          conflict_id: null,
          level: rule.level,
          trigger_reason: reason,
          source: 'rule',
          revision
        });
      }
    }
  }

  const updatedConflicts = updateConflictSeveritiesFromRisks(contractId, revision);

  return { annotations, updated_conflicts: updatedConflicts };
}

function getClauseRiskLevel(contractId, clauseId, revision = 1) {
  const annotations = queryAll(
    'SELECT level FROM risk_annotations WHERE contract_id = ? AND clause_id = ? AND revision = ?',
    [contractId, clauseId, revision]
  );

  if (annotations.length === 0) return null;

  let highest = 'low';
  for (const a of annotations) {
    if (LEVEL_ORDER[a.level] > LEVEL_ORDER[highest]) {
      highest = a.level;
    }
  }
  return highest;
}

module.exports = { annotateRisks, getClauseRiskLevel, evaluateCondition, updateConflictSeveritiesFromRisks, syncConflictDerivedRiskLevel };
