const { queryAll, queryOne } = require('./database');
const { getDependencies } = require('./clauseDependency');

const DIMENSION_WEIGHTS = {
  conflict: 0.25,
  risk: 0.20,
  compliance: 0.25,
  execution: 0.20,
  dependency: 0.10
};

function getTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function clampScore(score) {
  return Math.max(0, Math.min(100, score));
}

function scoreConflicts(contractId, revision = 1) {
  const conflicts = queryAll(
    'SELECT * FROM detected_conflicts WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );

  if (conflicts.length === 0) {
    return { score: 100, has_data: true, breakdown: { unresolved: 0, confirmed: 0, dismissed: 0 }, details: { total: 0 } };
  }

  const reviewActions = queryAll(
    `SELECT ra.* FROM review_actions ra
     JOIN detected_conflicts dc ON ra.conflict_id = dc.id
     WHERE dc.contract_id = ? AND dc.revision = ?`,
    [contractId, revision]
  );

  const actionMap = {};
  for (const a of reviewActions) {
    actionMap[a.conflict_id] = a.action;
  }

  let unresolved = 0;
  let confirmed = 0;
  let dismissed = 0;

  for (const c of conflicts) {
    const action = actionMap[c.id];
    if (action === 'dismiss' || action === 'modify') {
      dismissed++;
    } else if (action === 'confirm') {
      confirmed++;
    } else {
      unresolved++;
    }
  }

  const deductions = (unresolved * 15) + (confirmed * 8);
  const score = clampScore(100 - deductions);

  return {
    score,
    has_data: true,
    breakdown: { unresolved, confirmed, dismissed },
    details: { total: conflicts.length, deductions }
  };
}

function scoreRisks(contractId, revision = 1) {
  const risks = queryAll(
    'SELECT * FROM risk_annotations WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );

  if (risks.length === 0) {
    return { score: 100, has_data: true, breakdown: { high: 0, medium: 0, low: 0 }, details: { total: 0 } };
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of risks) {
    if (counts[r.level] !== undefined) {
      counts[r.level]++;
    }
  }

  const deductions = (counts.high * 20) + (counts.medium * 10) + (counts.low * 3);
  const score = clampScore(100 - deductions);

  return {
    score,
    has_data: true,
    breakdown: counts,
    details: { total: risks.length, deductions }
  };
}

function scoreCompliance(contractId, revision = 1) {
  const findings = queryAll(
    'SELECT * FROM compliance_findings WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );

  if (findings.length === 0) {
    return { score: 100, has_data: false, breakdown: { critical: 0, major: 0, minor: 0 }, details: { total: 0, violations: 0 } };
  }

  const violations = findings.filter(f => f.status === 'violation');
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const v of violations) {
    if (counts[v.severity] !== undefined) {
      counts[v.severity]++;
    }
  }

  const deductions = (counts.critical * 25) + (counts.major * 15) + (counts.minor * 5);
  const score = clampScore(100 - deductions);

  return {
    score,
    has_data: true,
    breakdown: counts,
    details: { total: findings.length, violations: violations.length, deductions }
  };
}

function scoreExecution(contractId) {
  const plans = queryAll(
    'SELECT * FROM execution_plan WHERE contract_id = ?',
    [contractId]
  );

  if (plans.length === 0) {
    return { score: 100, has_data: false, breakdown: { overdue: 0, upcoming: 0, completed: 0, pending: 0, waived: 0 }, details: { total: 0, completion_rate: 0 } };
  }

  const today = getTodayStr();
  const sevenDaysLater = addDays(today, 7);

  let overdue = 0;
  let upcoming = 0;
  let completed = 0;
  let pending = 0;
  let waived = 0;

  for (const p of plans) {
    if (p.status === 'completed') {
      completed++;
    } else if (p.status === 'waived') {
      waived++;
    } else if (p.status === 'pending') {
      if (p.due_date < today) {
        overdue++;
      } else if (p.due_date <= sevenDaysLater) {
        upcoming++;
      } else {
        pending++;
      }
    }
  }

  const deductions = (overdue * 20) + (upcoming * 8);
  const score = clampScore(100 - deductions);
  const completionRate = plans.length > 0 ? Math.round((completed / plans.length) * 100) : 0;

  return {
    score,
    has_data: true,
    breakdown: { overdue, upcoming, completed, pending, waived },
    details: { total: plans.length, completion_rate: completionRate, deductions }
  };
}

function detectCycles(deps) {
  const graph = {};
  const nodes = new Set();
  for (const dep of deps) {
    nodes.add(dep.from_clause_id);
    nodes.add(dep.to_clause_id);
    if (!graph[dep.from_clause_id]) {
      graph[dep.from_clause_id] = [];
    }
    graph[dep.from_clause_id].push(dep.to_clause_id);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const n of nodes) color[n] = WHITE;

  let cycleCount = 0;

  function dfs(node) {
    color[node] = GRAY;
    const neighbors = graph[node] || [];
    for (const n of neighbors) {
      if (color[n] === GRAY) {
        cycleCount++;
      } else if (color[n] === WHITE) {
        dfs(n);
      }
    }
    color[node] = BLACK;
  }

  for (const n of nodes) {
    if (color[n] === WHITE) {
      dfs(n);
    }
  }

  return cycleCount;
}

function scoreDependencies(contractId, revision = 1) {
  const deps = getDependencies(contractId, revision);

  const clauses = queryAll(
    'SELECT clause_id FROM clauses WHERE contract_id = ?',
    [contractId]
  );
  const validClauseIds = new Set(clauses.map(c => c.clause_id));

  if (deps.length === 0) {
    return { score: 100, has_data: true, breakdown: { dangling: 0, cycles: 0 }, details: { total_deps: 0 } };
  }

  let dangling = 0;
  for (const dep of deps) {
    if (!validClauseIds.has(dep.to_clause_id) || !validClauseIds.has(dep.from_clause_id)) {
      dangling++;
    }
  }

  const cycles = detectCycles(deps);
  const deductions = (dangling * 12) + (cycles * 18);
  const score = clampScore(100 - deductions);

  return {
    score,
    has_data: true,
    breakdown: { dangling, cycles },
    details: { total_deps: deps.length, deductions }
  };
}

function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function getWeakestDimension(dimensions) {
  let weakest = null;
  let lowestScore = Infinity;

  for (const [key, dim] of Object.entries(dimensions)) {
    if (!dim.has_data) continue;
    if (dim.score < lowestScore) {
      lowestScore = dim.score;
      weakest = key;
    }
  }

  return weakest;
}

const DIMENSION_LABELS = {
  conflict: '冲突维度',
  risk: '风险维度',
  compliance: '合规维度',
  execution: '履约维度',
  dependency: '依赖维度'
};

function runHealthCheck(contractId, revision = 1) {
  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    const err = new Error('合同不存在');
    err.status = 404;
    throw err;
  }

  const conflict = scoreConflicts(contractId, revision);
  const risk = scoreRisks(contractId, revision);
  const compliance = scoreCompliance(contractId, revision);
  const execution = scoreExecution(contractId);
  const dependency = scoreDependencies(contractId, revision);

  const dimensions = { conflict, risk, compliance, execution, dependency };

  let totalScore = 0;
  for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    totalScore += dimensions[key].score * weight;
  }
  totalScore = Math.round(totalScore * 10) / 10;

  const grade = getGrade(totalScore);
  const weakestDimension = getWeakestDimension(dimensions);

  const dimensionScores = {};
  for (const [key, dim] of Object.entries(dimensions)) {
    dimensionScores[key] = {
      score: dim.score,
      label: DIMENSION_LABELS[key],
      weight: DIMENSION_WEIGHTS[key],
      has_data: dim.has_data,
      breakdown: dim.breakdown,
      details: dim.details
    };
  }

  return {
    contract_id: contract.id,
    contract_title: contract.title,
    revision,
    total_score: totalScore,
    grade,
    weakest_dimension: weakestDimension ? {
      key: weakestDimension,
      label: DIMENSION_LABELS[weakestDimension],
      score: dimensions[weakestDimension].score
    } : null,
    dimensions: dimensionScores,
    generated_at: new Date().toISOString()
  };
}

function runBatchHealthCheck(contractIds, revision = 1) {
  if (!Array.isArray(contractIds) || contractIds.length === 0) {
    const err = new Error('contract_ids为必填数组');
    err.status = 400;
    throw err;
  }

  const results = [];
  const errors = [];

  for (const id of contractIds) {
    try {
      const report = runHealthCheck(id, revision);
      results.push(report);
    } catch (err) {
      errors.push({
        contract_id: id,
        error: err.message
      });
    }
  }

  results.sort((a, b) => a.total_score - b.total_score);

  return {
    total_contracts: contractIds.length,
    successful: results.length,
    failed: errors.length,
    reports: results,
    errors
  };
}

module.exports = {
  runHealthCheck,
  runBatchHealthCheck,
  scoreConflicts,
  scoreRisks,
  scoreCompliance,
  scoreExecution,
  scoreDependencies,
  getGrade
};
