const { queryAll, queryOne, runSql } = require('./database');
const { extractQuantities } = require('./conflictDetection');

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

function annotateRisks(contractId) {
  const clauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
  const riskRules = queryAll('SELECT * FROM risk_rules');

  runSql('DELETE FROM risk_annotations WHERE contract_id = ?', [contractId]);

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

        runSql(
          'INSERT INTO risk_annotations (contract_id, clause_id, rule_id, level, trigger_reason) VALUES (?, ?, ?, ?, ?)',
          [contractId, clause.clause_id, rule.id, rule.level, reason]
        );

        const row = queryOne('SELECT last_insert_rowid() as id');

        annotations.push({
          id: row.id,
          contract_id: contractId,
          clause_id: clause.clause_id,
          rule_id: rule.id,
          level: rule.level,
          trigger_reason: reason
        });
      }
    }
  }

  return annotations;
}

function getClauseRiskLevel(contractId, clauseId) {
  const annotations = queryAll(
    'SELECT level FROM risk_annotations WHERE contract_id = ? AND clause_id = ?',
    [contractId, clauseId]
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

module.exports = { annotateRisks, getClauseRiskLevel, evaluateCondition };
