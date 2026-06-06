const { queryAll, queryOne, runSql } = require('./database');
const { extractQuantities, detectContradiction, detectSameTagConflict, SEVERITY_TO_RISK_LEVEL } = require('./conflictDetection');

const EXCLUSIVITY_KEYWORDS = ['独家', '独占', '唯一', '排他', '不得与第三方', '不得向第三方', '不得与其他', '不得与任何第三方'];
const THIRD_PARTY_SERVICE_KEYWORDS = ['第三方', '其他方', '合作方', '供应商', '服务商', '外包'];
const SERVICE_CONTEXT_KEYWORDS = ['服务', '合作', '开发', '运维', '咨询', '技术支持', '解决方案'];

function detectExclusivityViolation(clauseA, clauseB) {
  const textA = clauseA.body;
  const textB = clauseB.body;

  let aIsExclusive = false;
  for (const kw of EXCLUSIVITY_KEYWORDS) {
    if (textA.includes(kw)) {
      aIsExclusive = true;
      break;
    }
  }

  let bIsExclusive = false;
  for (const kw of EXCLUSIVITY_KEYWORDS) {
    if (textB.includes(kw)) {
      bIsExclusive = true;
      break;
    }
  }

  let aHasThirdPartyService = false;
  for (const tpKw of THIRD_PARTY_SERVICE_KEYWORDS) {
    if (textA.includes(tpKw)) {
      for (const svcKw of SERVICE_CONTEXT_KEYWORDS) {
        if (textA.includes(svcKw)) {
          aHasThirdPartyService = true;
          break;
        }
      }
      if (aHasThirdPartyService) break;
    }
  }

  let bHasThirdPartyService = false;
  for (const tpKw of THIRD_PARTY_SERVICE_KEYWORDS) {
    if (textB.includes(tpKw)) {
      for (const svcKw of SERVICE_CONTEXT_KEYWORDS) {
        if (textB.includes(svcKw)) {
          bHasThirdPartyService = true;
          break;
        }
      }
      if (bHasThirdPartyService) break;
    }
  }

  if ((aIsExclusive && bHasThirdPartyService) || (bIsExclusive && aHasThirdPartyService)) {
    const exclusiveClause = aIsExclusive ? clauseA : clauseB;
    const thirdPartyClause = aIsExclusive ? clauseB : clauseA;
    return {
      conflict_type: 'exclusivity_violation',
      severity: 'critical',
      reason: `合同"${exclusiveClause._contract_title}"的条款"${exclusiveClause.title}"明确约定了独家/排他性合作约束(正文摘要: ${exclusiveClause.body.substring(0, 60)}...),而合同"${thirdPartyClause._contract_title}"的条款"${thirdPartyClause.title}"涉及与第三方的同类服务合作(正文摘要: ${thirdPartyClause.body.substring(0, 60)}...),两者构成直接冲突,违反独家合作约定。`
    };
  }

  return null;
}

function buildCrossConflictReason(clauseA, clauseB, rule, conflictType) {
  const tagsA = Array.isArray(clauseA.tags) ? clauseA.tags : JSON.parse(clauseA.tags);
  const tagsB = Array.isArray(clauseB.tags) ? clauseB.tags : JSON.parse(clauseB.tags);
  if (conflictType === 'contradiction') {
    return `合同"${clauseA._contract_title}"的条款"${clauseA.title}"包含"${rule.tag_a}"约束(正文摘要: ${clauseA.body.substring(0, 60)}...),与合同"${clauseB._contract_title}"的条款"${clauseB.title}"包含的"${rule.tag_b}"约束(正文摘要: ${clauseB.body.substring(0, 60)}...)直接矛盾,构成跨合同冲突。`;
  }
  return `合同"${clauseA._contract_title}"的条款"${clauseA.title}"(标签: ${tagsA.join(',')})与合同"${clauseB._contract_title}"的条款"${clauseB.title}"(标签: ${tagsB.join(',')})在"${rule.tag_a}"与"${rule.tag_b}"上存在潜在重叠歧义,建议人工审阅确认。`;
}

function getHighRiskClauseIds(contractIds, revision = 1) {
  const placeholders = contractIds.map(() => '?').join(',');
  const rows = queryAll(
    `SELECT DISTINCT contract_id, clause_id FROM risk_annotations 
     WHERE contract_id IN (${placeholders}) AND revision = ? AND level = ?`,
    [...contractIds, revision, 'high']
  );
  const result = new Set();
  for (const r of rows) {
    result.add(`${r.contract_id}|${r.clause_id}`);
  }
  return result;
}

function generateBatchId() {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function scanCrossContractConflicts(contractIds, revision = 1) {
  if (!Array.isArray(contractIds) || contractIds.length < 2) {
    return { error: '至少需要选择2份合同进行跨合同扫描', status: 400 };
  }

  const uniqueIds = [...new Set(contractIds.map(id => parseInt(id)))];
  if (uniqueIds.length < 2) {
    return { error: '请选择至少2份不同的合同', status: 400 };
  }

  const placeholders = uniqueIds.map(() => '?').join(',');
  const contracts = queryAll(
    `SELECT id, title, parties FROM contracts WHERE id IN (${placeholders})`,
    uniqueIds
  );

  if (contracts.length !== uniqueIds.length) {
    const foundIds = new Set(contracts.map(c => c.id));
    const missing = uniqueIds.filter(id => !foundIds.has(id));
    return { error: `以下合同不存在: ${missing.join(', ')}`, status: 404 };
  }

  const contractMap = {};
  for (const c of contracts) {
    contractMap[c.id] = { ...c, parties: JSON.parse(c.parties) };
  }

  const allClausesResult = queryAll(
    `SELECT contract_id, clause_id, section, title, body, tags FROM clauses WHERE contract_id IN (${placeholders})`,
    uniqueIds
  );

  const clausesByContract = {};
  for (const row of allClausesResult) {
    const cid = row.contract_id;
    if (!clausesByContract[cid]) clausesByContract[cid] = [];
    clausesByContract[cid].push({
      ...row,
      tags: JSON.parse(row.tags),
      _contract_title: contractMap[cid].title,
      _tags_json: row.tags
    });
  }

  const conflictRules = queryAll('SELECT * FROM conflict_rules');

  const conflicts = [];
  const conflictPairs = new Set();

  for (let i = 0; i < uniqueIds.length; i++) {
    for (let j = i + 1; j < uniqueIds.length; j++) {
      const cidA = uniqueIds[i];
      const cidB = uniqueIds[j];
      const clausesA = clausesByContract[cidA] || [];
      const clausesB = clausesByContract[cidB] || [];

      for (const a of clausesA) {
        for (const b of clausesB) {
          const tagsA = a.tags;
          const tagsB = b.tags;

          let foundRuleConflict = false;
          for (const rule of conflictRules) {
            const aHasTagA = tagsA.includes(rule.tag_a);
            const bHasTagB = tagsB.includes(rule.tag_b);
            const aHasTagB = tagsA.includes(rule.tag_b);
            const bHasTagA = tagsB.includes(rule.tag_a);

            if ((aHasTagA && bHasTagB) || (aHasTagB && bHasTagA)) {
              const qtyA = extractQuantities(a.body);
              const qtyB = extractQuantities(b.body);

              const clauseWithA = (aHasTagA && bHasTagB) ? a : b;
              const clauseWithB = (aHasTagA && bHasTagB) ? b : a;

              const result = detectContradiction(qtyA, qtyB, tagsA, tagsB, rule, a.body, b.body);

              if (result) {
                const reason = buildCrossConflictReason(clauseWithA, clauseWithB, rule, result.conflict_type);
                const pairKey = [cidA, cidB, a.clause_id, b.clause_id].sort().join('|');
                if (!conflictPairs.has(pairKey)) {
                  conflictPairs.add(pairKey);
                  conflicts.push({
                    contract_a_id: cidA,
                    contract_b_id: cidB,
                    clause_a_id: a.clause_id,
                    clause_b_id: b.clause_id,
                    clause_a_title: a.title,
                    clause_b_title: b.title,
                    conflict_type: result.conflict_type,
                    severity: result.severity,
                    original_severity: result.severity,
                    risk_propagated: 0,
                    reason
                  });
                }
                foundRuleConflict = true;
                break;
              } else {
                const pairKey = [cidA, cidB, a.clause_id, b.clause_id].sort().join('|');
                if (!conflictPairs.has(pairKey)) {
                  conflictPairs.add(pairKey);
                  conflicts.push({
                    contract_a_id: cidA,
                    contract_b_id: cidB,
                    clause_a_id: a.clause_id,
                    clause_b_id: b.clause_id,
                    clause_a_title: a.title,
                    clause_b_title: b.title,
                    conflict_type: 'ambiguity',
                    severity: 'warning',
                    original_severity: 'warning',
                    risk_propagated: 0,
                    reason: buildCrossConflictReason(clauseWithA, clauseWithB, rule, 'ambiguity')
                  });
                  foundRuleConflict = true;
                  break;
                }
              }
            }
          }

          if (!foundRuleConflict) {
            const commonTags = tagsA.filter(t => tagsB.includes(t));
            for (const tag of commonTags) {
              if (['liability_cap', 'payment_term', 'termination', 'confidentiality', 'transfer_restriction'].includes(tag)) {
                const aWithTagsStr = { ...a, tags: a._tags_json };
                const bWithTagsStr = { ...b, tags: b._tags_json };
                const sameTagConflict = detectSameTagConflict(aWithTagsStr, bWithTagsStr, tag);
                if (sameTagConflict) {
                  const pairKey = [cidA, cidB, a.clause_id, b.clause_id].sort().join('|');
                  if (!conflictPairs.has(pairKey)) {
                    conflictPairs.add(pairKey);
                    conflicts.push({
                      contract_a_id: cidA,
                      contract_b_id: cidB,
                      clause_a_id: a.clause_id,
                      clause_b_id: b.clause_id,
                      clause_a_title: a.title,
                      clause_b_title: b.title,
                      conflict_type: sameTagConflict.conflict_type,
                      severity: sameTagConflict.severity,
                      original_severity: sameTagConflict.severity,
                      risk_propagated: 0,
                      reason: `合同"${a._contract_title}"的条款"${a.title}"与合同"${b._contract_title}"的条款"${b.title}"同属"${tag}"约束,量化约束存在逻辑矛盾(下限高于上限或方向相反),构成跨合同冲突。`
                    });
                  }
                  break;
                }
              }
            }
          }

          const exclusivityViolation = detectExclusivityViolation(a, b);
          if (exclusivityViolation) {
            const pairKey = [cidA, cidB, a.clause_id, b.clause_id, 'excl'].sort().join('|');
            if (!conflictPairs.has(pairKey)) {
              conflictPairs.add(pairKey);
              conflicts.push({
                contract_a_id: cidA,
                contract_b_id: cidB,
                clause_a_id: a.clause_id,
                clause_b_id: b.clause_id,
                clause_a_title: a.title,
                clause_b_title: b.title,
                conflict_type: exclusivityViolation.conflict_type,
                severity: exclusivityViolation.severity,
                original_severity: exclusivityViolation.severity,
                risk_propagated: 0,
                reason: exclusivityViolation.reason
              });
            }
          }
        }
      }
    }
  }

  const highRiskClauseIds = getHighRiskClauseIds(uniqueIds, revision);
  const propagatedRisks = [];

  for (const conflict of conflicts) {
    const keyA = `${conflict.contract_a_id}|${conflict.clause_a_id}`;
    const keyB = `${conflict.contract_b_id}|${conflict.clause_b_id}`;
    const aHigh = highRiskClauseIds.has(keyA);
    const bHigh = highRiskClauseIds.has(keyB);
    const hasHighRisk = aHigh || bHigh;
    const bothHigh = aHigh && bHigh;

    if (hasHighRisk) {
      if (conflict.severity !== 'critical') {
        conflict.severity = 'critical';
      }
      if (!bothHigh) {
        conflict.risk_propagated = 1;
      }
    }
  }

  const batchId = generateBatchId();

  runSql(`DELETE FROM cross_contract_conflicts WHERE scan_batch = ?`, [batchId]);
  runSql(`DELETE FROM risk_annotations WHERE source = ?`, ['cross_contract']);

  const inserted = [];
  for (const c of conflicts) {
    const result = runSql(
      `INSERT INTO cross_contract_conflicts 
       (contract_a_id, contract_b_id, clause_a_id, clause_b_id, conflict_type, severity, original_severity, risk_propagated, reason, scan_batch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.contract_a_id, c.contract_b_id, c.clause_a_id, c.clause_b_id, c.conflict_type, c.severity, c.original_severity, c.risk_propagated, c.reason, batchId]
    );
    const insertedConflict = { ...c, id: result.lastInsertRowid, scan_batch: batchId };
    inserted.push(insertedConflict);

    if (insertedConflict.risk_propagated) {
      const keyA = `${insertedConflict.contract_a_id}|${insertedConflict.clause_a_id}`;
      const keyB = `${insertedConflict.contract_b_id}|${insertedConflict.clause_b_id}`;
      const aWasHigh = highRiskClauseIds.has(keyA);
      const bWasHigh = highRiskClauseIds.has(keyB);

      if (aWasHigh && !bWasHigh) {
        const riskLevel = SEVERITY_TO_RISK_LEVEL[insertedConflict.severity] || 'high';
        const triggerReason = `跨合同风险传播: 合同"${contractMap[insertedConflict.contract_a_id].title}"的条款"${insertedConflict.clause_a_title}"已被标注为高风险,其与合同"${contractMap[insertedConflict.contract_b_id].title}"的条款"${insertedConflict.clause_b_title}"存在${insertedConflict.conflict_type === 'contradiction' ? '矛盾' : insertedConflict.conflict_type === 'exclusivity_violation' ? '独家违约' : '歧义/重叠'}冲突(冲突ID=${insertedConflict.id}),因此关联条款风险升级。`;
        const riskResult = runSql(
          `INSERT INTO risk_annotations (contract_id, clause_id, rule_id, conflict_id, cross_conflict_id, level, trigger_reason, source, revision) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          [insertedConflict.contract_b_id, insertedConflict.clause_b_id, insertedConflict.id, riskLevel, triggerReason, 'cross_contract', revision]
        );
        propagatedRisks.push({
          id: riskResult.lastInsertRowid,
          contract_id: insertedConflict.contract_b_id,
          clause_id: insertedConflict.clause_b_id,
          clause_title: insertedConflict.clause_b_title,
          level: riskLevel,
          source: 'cross_contract',
          cross_conflict_id: insertedConflict.id,
          trigger_reason: triggerReason
        });
      }

      if (bWasHigh && !aWasHigh) {
        const riskLevel = SEVERITY_TO_RISK_LEVEL[insertedConflict.severity] || 'high';
        const triggerReason = `跨合同风险传播: 合同"${contractMap[insertedConflict.contract_b_id].title}"的条款"${insertedConflict.clause_b_title}"已被标注为高风险,其与合同"${contractMap[insertedConflict.contract_a_id].title}"的条款"${insertedConflict.clause_a_title}"存在${insertedConflict.conflict_type === 'contradiction' ? '矛盾' : insertedConflict.conflict_type === 'exclusivity_violation' ? '独家违约' : '歧义/重叠'}冲突(冲突ID=${insertedConflict.id}),因此关联条款风险升级。`;
        const riskResult = runSql(
          `INSERT INTO risk_annotations (contract_id, clause_id, rule_id, conflict_id, cross_conflict_id, level, trigger_reason, source, revision) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          [insertedConflict.contract_a_id, insertedConflict.clause_a_id, insertedConflict.id, riskLevel, triggerReason, 'cross_contract', revision]
        );
        propagatedRisks.push({
          id: riskResult.lastInsertRowid,
          contract_id: insertedConflict.contract_a_id,
          clause_id: insertedConflict.clause_a_id,
          clause_title: insertedConflict.clause_a_title,
          level: riskLevel,
          source: 'cross_contract',
          cross_conflict_id: insertedConflict.id,
          trigger_reason: triggerReason
        });
      }
    }
  }

  const matrix = [];
  const contractList = contracts.sort((a, b) => a.id - b.id);
  for (let i = 0; i < contractList.length; i++) {
    const row = { contract_id: contractList[i].id, contract_title: contractList[i].title, counts: {} };
    for (let j = 0; j < contractList.length; j++) {
      const cidX = contractList[i].id;
      const cidY = contractList[j].id;
      if (cidX === cidY) {
        row.counts[cidY] = { total: 0, critical: 0, warning: 0, diagonal: true };
      } else {
        const pairConflicts = inserted.filter(c =>
          (c.contract_a_id === cidX && c.contract_b_id === cidY) ||
          (c.contract_a_id === cidY && c.contract_b_id === cidX)
        );
        row.counts[cidY] = {
          total: pairConflicts.length,
          critical: pairConflicts.filter(c => c.severity === 'critical').length,
          warning: pairConflicts.filter(c => c.severity === 'warning').length,
          diagonal: false
        };
      }
    }
    matrix.push(row);
  }

  const contracts_info = {};
  for (const c of contracts) {
    contracts_info[c.id] = { id: c.id, title: c.title, parties: JSON.parse(c.parties) };
  }

  return {
    scan_batch: batchId,
    contracts_scanned: uniqueIds.length,
    contracts_info,
    conflicts: inserted,
    propagated_risks: propagatedRisks,
    conflict_summary: {
      total: inserted.length,
      critical: inserted.filter(c => c.severity === 'critical').length,
      warning: inserted.filter(c => c.severity === 'warning').length,
      exclusivity_violations: inserted.filter(c => c.conflict_type === 'exclusivity_violation').length,
      risk_propagated_count: inserted.filter(c => c.risk_propagated === 1).length
    },
    relationship_matrix: {
      contract_ids: contractList.map(c => c.id),
      contract_titles: contractList.map(c => c.title),
      rows: matrix
    }
  };
}

function getCrossContractScanResult(batchId) {
  if (!batchId) {
    return { error: 'batch_id为必填项', status: 400 };
  }

  const conflicts = queryAll(
    'SELECT * FROM cross_contract_conflicts WHERE scan_batch = ? ORDER BY severity DESC, id ASC',
    [batchId]
  );

  if (conflicts.length === 0) {
    return { error: '未找到该批次的扫描结果', status: 404 };
  }

  const uniqueContractIds = [...new Set([
    ...conflicts.map(c => c.contract_a_id),
    ...conflicts.map(c => c.contract_b_id)
  ])];

  const placeholders = uniqueContractIds.map(() => '?').join(',');
  const contracts = queryAll(
    `SELECT id, title, parties FROM contracts WHERE id IN (${placeholders})`,
    uniqueContractIds
  );
  const contractMap = {};
  for (const c of contracts) {
    contractMap[c.id] = { ...c, parties: JSON.parse(c.parties) };
  }

  const contractList = contracts.sort((a, b) => a.id - b.id);
  const matrix = [];
  for (let i = 0; i < contractList.length; i++) {
    const row = { contract_id: contractList[i].id, contract_title: contractList[i].title, counts: {} };
    for (let j = 0; j < contractList.length; j++) {
      const cidX = contractList[i].id;
      const cidY = contractList[j].id;
      if (cidX === cidY) {
        row.counts[cidY] = { total: 0, critical: 0, warning: 0, diagonal: true };
      } else {
        const pairConflicts = conflicts.filter(c =>
          (c.contract_a_id === cidX && c.contract_b_id === cidY) ||
          (c.contract_a_id === cidY && c.contract_b_id === cidX)
        );
        row.counts[cidY] = {
          total: pairConflicts.length,
          critical: pairConflicts.filter(c => c.severity === 'critical').length,
          warning: pairConflicts.filter(c => c.severity === 'warning').length,
          diagonal: false
        };
      }
    }
    matrix.push(row);
  }

  const propagatedRisks = queryAll(
    `SELECT * FROM risk_annotations WHERE source = ?`,
    ['cross_contract']
  );

  return {
    scan_batch: batchId,
    contracts_scanned: uniqueContractIds.length,
    contracts_info: contractMap,
    conflicts,
    propagated_risks: propagatedRisks,
    conflict_summary: {
      total: conflicts.length,
      critical: conflicts.filter(c => c.severity === 'critical').length,
      warning: conflicts.filter(c => c.severity === 'warning').length,
      exclusivity_violations: conflicts.filter(c => c.conflict_type === 'exclusivity_violation').length,
      risk_propagated_count: conflicts.filter(c => c.risk_propagated === 1).length
    },
    relationship_matrix: {
      contract_ids: contractList.map(c => c.id),
      contract_titles: contractList.map(c => c.title),
      rows: matrix
    }
  };
}

module.exports = {
  scanCrossContractConflicts,
  getCrossContractScanResult,
  detectExclusivityViolation
};
