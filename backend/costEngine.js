const { queryAll, queryOne, runSql } = require('./database');
const { extractQuantities } = require('./conflictDetection');

function createCostModel(data) {
  const { name, target_tag, value_dimension, formula_type, params } = data;

  if (!name || !target_tag || !value_dimension || !formula_type) {
    throw new Error('name, target_tag, value_dimension, formula_type为必填项');
  }

  if (!['amount', 'duration', 'percentage'].includes(value_dimension)) {
    throw new Error('value_dimension必须是amount/duration/percentage之一');
  }

  if (!['linear', 'threshold'].includes(formula_type)) {
    throw new Error('formula_type必须是linear/threshold之一');
  }

  if (formula_type === 'linear') {
    if (!params || typeof params.coefficient !== 'number') {
      throw new Error('linear公式需要params.coefficient参数');
    }
  }

  if (formula_type === 'threshold') {
    if (!params || typeof params.threshold !== 'number' || typeof params.penalty !== 'number') {
      throw new Error('threshold公式需要params.threshold和params.penalty参数');
    }
  }

  const result = runSql(
    'INSERT INTO cost_models (name, target_tag, value_dimension, formula_type, params_json) VALUES (?, ?, ?, ?, ?)',
    [name, target_tag, value_dimension, formula_type, JSON.stringify(params || {})]
  );

  const row = queryOne('SELECT * FROM cost_models WHERE id = ?', [result.lastInsertRowid]);
  return formatCostModel(row);
}

function getCostModels() {
  const rows = queryAll('SELECT * FROM cost_models ORDER BY created_at DESC');
  return rows.map(formatCostModel);
}

function deleteCostModel(id) {
  const existing = queryOne('SELECT * FROM cost_models WHERE id = ?', [id]);
  if (!existing) return false;
  runSql('DELETE FROM cost_models WHERE id = ?', [id]);
  return true;
}

function formatCostModel(row) {
  return {
    id: row.id,
    name: row.name,
    target_tag: row.target_tag,
    value_dimension: row.value_dimension,
    formula_type: row.formula_type,
    params: JSON.parse(row.params_json),
    created_at: row.created_at
  };
}

function calculateImpact(oldValue, newValue, model) {
  const { formula_type, params } = model;
  let impact = 0;
  let direction = 'neutral';

  if (formula_type === 'linear') {
    const coefficient = params.coefficient;
    const delta = newValue - oldValue;
    const rawImpact = delta * coefficient;
    impact = Math.abs(rawImpact);
    if (rawImpact > 0) {
      direction = 'increase';
    } else if (rawImpact < 0) {
      direction = 'decrease';
    }
  } else if (formula_type === 'threshold') {
    const { threshold, penalty, compare_type } = params;
    const compare = compare_type || 'exceed';
    let triggered = false;
    if (compare === 'exceed') {
      triggered = newValue > threshold && oldValue <= threshold;
    } else if (compare === 'drop_below') {
      triggered = newValue < threshold && oldValue >= threshold;
    }
    if (triggered) {
      impact = Math.abs(penalty);
      direction = penalty > 0 ? 'increase' : 'decrease';
    }
  }

  return { impact, direction };
}

function extractDimensionValue(text, dimension) {
  const quantities = extractQuantities(text);
  const filtered = quantities.filter(q => q.type === dimension);
  if (filtered.length === 0) return null;

  let selected = filtered[0];
  if (dimension === 'amount') {
    selected = filtered.reduce((acc, cur) => (cur.value > acc.value ? cur : acc), filtered[0]);
  } else if (dimension === 'duration') {
    selected = filtered.reduce((acc, cur) => (cur.value > acc.value ? cur : acc), filtered[0]);
  } else if (dimension === 'percentage') {
    selected = filtered[filtered.length - 1];
  }

  return selected.value;
}

function findMatchingModels(tags) {
  const allModels = getCostModels();
  return allModels.filter(m => tags.includes(m.target_tag));
}

function evaluateRevisionImpact(contractId, fromRevision, toRevision) {
  const fromData = queryOne(
    'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
    [contractId, fromRevision]
  );
  const toData = queryOne(
    'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
    [contractId, toRevision]
  );

  if (!fromData || !toData) {
    throw new Error('指定的版本不存在');
  }

  const fromClauses = JSON.parse(fromData.clauses_json);
  const toClauses = JSON.parse(toData.clauses_json);

  const fromClauseMap = {};
  for (const c of fromClauses) {
    fromClauseMap[c.clause_id] = c;
  }
  const toClauseMap = {};
  for (const c of toClauses) {
    toClauseMap[c.clause_id] = c;
  }

  const details = [];
  let costIncreaseTotal = 0;
  let costDecreaseTotal = 0;

  for (const clauseId of Object.keys(toClauseMap)) {
    const oldClause = fromClauseMap[clauseId];
    const newClause = toClauseMap[clauseId];

    if (!oldClause || !newClause) continue;
    if (oldClause.body === newClause.body) continue;

    const tags = newClause.tags || [];
    const matchingModels = findMatchingModels(tags);

    for (const model of matchingModels) {
      const oldValue = extractDimensionValue(oldClause.body, model.value_dimension);
      const newValue = extractDimensionValue(newClause.body, model.value_dimension);

      if (oldValue === null || newValue === null) continue;

      const { impact, direction } = calculateImpact(oldValue, newValue, model);

      if (impact > 0) {
        details.push({
          clause_id: clauseId,
          clause_title: newClause.title,
          old_value: oldValue,
          new_value: newValue,
          value_dimension: model.value_dimension,
          model_name: model.name,
          impact: Math.round(impact * 100) / 100,
          direction
        });

        if (direction === 'increase') {
          costIncreaseTotal += impact;
        } else if (direction === 'decrease') {
          costDecreaseTotal += impact;
        }
      }
    }
  }

  const totalImpact = costIncreaseTotal + costDecreaseTotal;
  const netImpact = costIncreaseTotal - costDecreaseTotal;

  return {
    contract_id: contractId,
    from_revision: fromRevision,
    to_revision: toRevision,
    total_impact: Math.round(totalImpact * 100) / 100,
    details,
    summary: {
      cost_increase_total: Math.round(costIncreaseTotal * 100) / 100,
      cost_decrease_total: Math.round(costDecreaseTotal * 100) / 100,
      net_impact: Math.round(netImpact * 100) / 100
    }
  };
}

function batchEvaluateImpact(contractIds, fromRevision, toRevision) {
  const contracts = [];
  let totalIncrease = 0;
  let totalDecrease = 0;

  for (const contractId of contractIds) {
    try {
      const result = evaluateRevisionImpact(contractId, fromRevision, toRevision);
      contracts.push({
        contract_id: contractId,
        total_impact: result.total_impact,
        net_impact: result.summary.net_impact,
        details_count: result.details.length
      });
      totalIncrease += result.summary.cost_increase_total;
      totalDecrease += result.summary.cost_decrease_total;
    } catch (err) {
      contracts.push({
        contract_id: contractId,
        error: err.message
      });
    }
  }

  return {
    contracts,
    aggregate: {
      total_increase: Math.round(totalIncrease * 100) / 100,
      total_decrease: Math.round(totalDecrease * 100) / 100,
      net: Math.round((totalIncrease - totalDecrease) * 100) / 100
    }
  };
}

function seedDemoCostModels() {
  const existing = queryOne('SELECT COUNT(*) as cnt FROM cost_models');
  if (existing && existing.cnt > 0) {
    return 0;
  }

  const demoModels = [
    {
      name: '付款期延长成本',
      target_tag: 'payment_term',
      value_dimension: 'duration',
      formula_type: 'linear',
      params: { coefficient: 0.05 }
    },
    {
      name: '责任上限降低损失',
      target_tag: 'liability_cap',
      value_dimension: 'amount',
      formula_type: 'linear',
      params: { coefficient: -1 }
    },
    {
      name: '保密期缩短风险',
      target_tag: 'confidentiality',
      value_dimension: 'duration',
      formula_type: 'threshold',
      params: { threshold: 180, penalty: 10, compare_type: 'drop_below' }
    }
  ];

  for (const m of demoModels) {
    createCostModel(m);
  }

  return demoModels.length;
}

module.exports = {
  createCostModel,
  getCostModels,
  deleteCostModel,
  evaluateRevisionImpact,
  batchEvaluateImpact,
  seedDemoCostModels,
  extractDimensionValue,
  calculateImpact
};
