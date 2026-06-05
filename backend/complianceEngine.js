const { queryAll, queryOne, runSql } = require('./database');
const { extractQuantities } = require('./conflictDetection');

function createRule(ruleData) {
  const { name, description, target_tags, check_type, check_params, severity, suggestion } = ruleData;

  if (!name || !description || !target_tags || !check_type || !check_params || !severity || !suggestion) {
    throw new Error('所有字段为必填项');
  }

  const validCheckTypes = ['contains', 'numeric_range', 'duration_range', 'required_field'];
  if (!validCheckTypes.includes(check_type)) {
    throw new Error('check_type必须是contains/numeric_range/duration_range/required_field之一');
  }

  const validSeverities = ['critical', 'major', 'minor'];
  if (!validSeverities.includes(severity)) {
    throw new Error('severity必须是critical/major/minor之一');
  }

  const result = runSql(
    'INSERT INTO compliance_rules (name, description, target_tags, check_type, check_params, severity, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, description, JSON.stringify(target_tags), check_type, JSON.stringify(check_params), severity, suggestion]
  );

  return {
    id: result.lastInsertRowid,
    name,
    description,
    target_tags,
    check_type,
    check_params,
    severity,
    suggestion
  };
}

function getRules(targetTag = null) {
  let sql = 'SELECT * FROM compliance_rules';
  let params = [];

  if (targetTag) {
    sql += ' WHERE target_tags LIKE ?';
    params.push(`%"${targetTag}"%`);
  }

  const rules = queryAll(sql, params);
  return rules.map(r => ({
    ...r,
    target_tags: JSON.parse(r.target_tags),
    check_params: JSON.parse(r.check_params)
  }));
}

function deleteRule(id) {
  const ruleId = parseInt(id);
  const existing = queryOne('SELECT * FROM compliance_rules WHERE id = ?', [ruleId]);
  if (!existing) {
    return false;
  }
  runSql('DELETE FROM compliance_rules WHERE id = ?', [ruleId]);
  return true;
}

function checkContains(text, checkParams) {
  const { keywords } = checkParams;
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return { pass: true, detail: '无关键词需要检查' };
  }

  const foundKeywords = keywords.filter(k => text.includes(k));
  if (foundKeywords.length > 0) {
    return { pass: true, detail: `找到关键词: ${foundKeywords.join(', ')}` };
  }
  return { pass: false, detail: `未找到任一关键词: ${keywords.join(', ')}` };
}

function checkNumericRange(text, checkParams) {
  const { type, min, max } = checkParams;
  const quantities = extractQuantities(text);

  let targetQuantities = [];
  if (type === 'amount') {
    targetQuantities = quantities.filter(q => q.type === 'amount');
  } else if (type === 'percentage') {
    targetQuantities = quantities.filter(q => q.type === 'percentage');
  }

  if (targetQuantities.length === 0) {
    return { pass: false, detail: `未找到${type === 'amount' ? '金额' : '百分比'}数值` };
  }

  const results = [];
  for (const qty of targetQuantities) {
    const val = type === 'percentage' ? qty.value * 100 : qty.value;
    const minCheck = min === undefined || val >= min;
    const maxCheck = max === undefined || val <= max;

    if (!minCheck || !maxCheck) {
      const rangeDesc = [];
      if (min !== undefined) rangeDesc.push(`≥ ${min}`);
      if (max !== undefined) rangeDesc.push(`≤ ${max}`);
      results.push(`数值 ${qty.raw} 不在合法范围(${rangeDesc.join(', ')})内`);
    }
  }

  if (results.length > 0) {
    return { pass: false, detail: results.join('; ') };
  }
  return { pass: true, detail: `数值检查通过` };
}

function checkDurationRange(text, checkParams) {
  const { min_days, max_days } = checkParams;
  const quantities = extractQuantities(text);
  const durations = quantities.filter(q => q.type === 'duration');

  if (durations.length === 0) {
    return { pass: false, detail: '未找到时间期限数值' };
  }

  const results = [];
  for (const qty of durations) {
    const val = qty.value;
    const minCheck = min_days === undefined || val >= min_days;
    const maxCheck = max_days === undefined || val <= max_days;

    if (!minCheck || !maxCheck) {
      const rangeDesc = [];
      if (min_days !== undefined) rangeDesc.push(`≥ ${min_days}天`);
      if (max_days !== undefined) rangeDesc.push(`≤ ${max_days}天`);
      results.push(`期限 ${qty.raw} 不在合法范围(${rangeDesc.join(', ')})内`);
    }
  }

  if (results.length > 0) {
    return { pass: false, detail: results.join('; ') };
  }
  return { pass: true, detail: '期限检查通过' };
}

function auditContract(contractId, revision = 1, clausesInput = null) {
  const contractIdNum = parseInt(contractId);
  const revisionNum = parseInt(revision);

  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractIdNum]);
  if (!contract) {
    throw new Error('合同不存在');
  }

  let clauses;
  if (clausesInput) {
    clauses = clausesInput.map(c => ({
      ...c,
      tags: typeof c.tags === 'string' ? JSON.parse(c.tags) : c.tags
    }));
  } else if (revisionNum === 1) {
    clauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractIdNum]);
    clauses = clauses.map(c => ({ ...c, tags: JSON.parse(c.tags) }));
  } else {
    const revisionData = queryOne(
      'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractIdNum, revisionNum]
    );
    if (!revisionData) {
      throw new Error('版本不存在');
    }
    clauses = JSON.parse(revisionData.clauses_json);
  }

  const allRules = getRules();

  const clauseTags = new Set();
  for (const clause of clauses) {
    for (const tag of clause.tags) {
      clauseTags.add(tag);
    }
  }

  const findings = [];

  for (const rule of allRules) {
    if (rule.check_type === 'required_field') {
      let hasMatchingClause = false;
      for (const tag of rule.target_tags) {
        if (clauseTags.has(tag)) {
          hasMatchingClause = true;
          break;
        }
      }

      findings.push({
        clause_id: null,
        rule_id: rule.id,
        rule_name: rule.name,
        severity: rule.severity,
        status: hasMatchingClause ? 'pass' : 'violation',
        detail: hasMatchingClause ? `找到${rule.target_tags.join('/')}类型的条款` : `缺少${rule.target_tags.join('/')}类型的条款`,
        suggestion: rule.suggestion
      });
    } else {
      for (const clause of clauses) {
        const hasMatchingTag = rule.target_tags.some(t => clause.tags.includes(t));
        if (!hasMatchingTag) continue;

        let checkResult;
        switch (rule.check_type) {
          case 'contains':
            checkResult = checkContains(clause.body, rule.check_params);
            break;
          case 'numeric_range':
            checkResult = checkNumericRange(clause.body, rule.check_params);
            break;
          case 'duration_range':
            checkResult = checkDurationRange(clause.body, rule.check_params);
            break;
          default:
            checkResult = { pass: true, detail: '未知检查类型' };
        }

        findings.push({
          clause_id: clause.clause_id,
          rule_id: rule.id,
          rule_name: rule.name,
          severity: rule.severity,
          status: checkResult.pass ? 'pass' : 'violation',
          detail: checkResult.detail,
          suggestion: rule.suggestion
        });
      }
    }
  }

  runSql('DELETE FROM compliance_findings WHERE contract_id = ? AND revision = ?', [contractIdNum, revisionNum]);

  const insertedFindings = [];
  for (const f of findings) {
    runSql(
      'INSERT INTO compliance_findings (contract_id, revision, clause_id, rule_id, rule_name, severity, status, detail, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [contractIdNum, revisionNum, f.clause_id, f.rule_id, f.rule_name, f.severity, f.status, f.detail, f.suggestion]
    );
    const row = queryOne('SELECT last_insert_rowid() as id');
    insertedFindings.push({ ...f, id: row.id });
  }

  return insertedFindings;
}

function getAuditResults(contractId, revision = 1) {
  const contractIdNum = parseInt(contractId);
  const revisionNum = parseInt(revision);

  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractIdNum]);
  if (!contract) {
    throw new Error('合同不存在');
  }

  if (revisionNum > 1) {
    const revisionData = queryOne(
      'SELECT * FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractIdNum, revisionNum]
    );
    if (!revisionData) {
      throw new Error('版本不存在');
    }
  }

  const findings = queryAll(
    'SELECT * FROM compliance_findings WHERE contract_id = ? AND revision = ?',
    [contractIdNum, revisionNum]
  );

  return findings;
}

function batchAudit(contractIds) {
  const results = [];
  let totalFindings = 0;
  const bySeverity = { critical: 0, major: 0, minor: 0 };

  for (const contractId of contractIds) {
    try {
      const findings = auditContract(contractId);
      const violations = findings.filter(f => f.status === 'violation');
      const criticalCount = violations.filter(f => f.severity === 'critical').length;

      results.push({
        contract_id: contractId,
        findings_count: violations.length,
        critical_count: criticalCount,
        success: true
      });

      totalFindings += violations.length;
      bySeverity.critical += criticalCount;
      bySeverity.major += violations.filter(f => f.severity === 'major').length;
      bySeverity.minor += violations.filter(f => f.severity === 'minor').length;
    } catch (err) {
      results.push({
        contract_id: contractId,
        findings_count: 0,
        critical_count: 0,
        success: false,
        error: err.message
      });
    }
  }

  return {
    total_contracts: contractIds.length,
    total_findings: totalFindings,
    by_severity: bySeverity,
    contracts: results
  };
}

function getComplianceReport(contractId, revision = 1) {
  const contractIdNum = parseInt(contractId);
  const revisionNum = parseInt(revision);

  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractIdNum]);
  if (!contract) {
    throw new Error('合同不存在');
  }

  if (revisionNum > 1) {
    const revisionData = queryOne(
      'SELECT * FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractIdNum, revisionNum]
    );
    if (!revisionData) {
      throw new Error('版本不存在');
    }
  }

  const findings = queryAll(
    'SELECT * FROM compliance_findings WHERE contract_id = ? AND revision = ?',
    [contractIdNum, revisionNum]
  );

  const totalRulesChecked = findings.length;
  const passCount = findings.filter(f => f.status === 'pass').length;
  const violationCount = findings.filter(f => f.status === 'violation').length;
  const complianceRate = totalRulesChecked > 0 ? Math.round((passCount / totalRulesChecked) * 100) : 100;

  const findingsBySeverity = {
    critical: [],
    major: [],
    minor: []
  };

  const missingClauses = [];

  for (const f of findings) {
    if (f.status === 'violation') {
      findingsBySeverity[f.severity].push({
        id: f.id,
        clause_id: f.clause_id,
        rule_id: f.rule_id,
        rule_name: f.rule_name,
        detail: f.detail,
        suggestion: f.suggestion
      });

      if (!f.clause_id) {
        missingClauses.push(f.rule_name);
      }
    }
  }

  const auditTime = findings.length > 0 ? findings[0].created_at : new Date().toISOString();

  return {
    contract_title: contract.title,
    audit_time: auditTime,
    total_rules_checked: totalRulesChecked,
    pass_count: passCount,
    violation_count: violationCount,
    compliance_rate: complianceRate,
    findings_by_severity: findingsBySeverity,
    missing_clauses: missingClauses
  };
}

module.exports = {
  createRule,
  getRules,
  deleteRule,
  auditContract,
  getAuditResults,
  batchAudit,
  getComplianceReport
};
