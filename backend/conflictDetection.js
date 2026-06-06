const { queryAll, queryOne, runSql } = require('./database');

function extractQuantities(text) {
  const quantities = [];

  const moneyPatterns = [
    { re: /(\d+(?:\.\d+)?)\s*万元/g, factor: 1, unit: '万元' },
    { re: /(\d+(?:\.\d+)?)\s*元(?!万)/g, factor: 1 / 10000, unit: '万元' },
    { re: /(\d+(?:\.\d+)?)\s*RMB/gi, factor: 1 / 10000, unit: '万元' },
    { re: /(\d+(?:\.\d+)?)\s*USD/gi, factor: 1 / 10000, unit: '万元' }
  ];

  for (const { re, factor, unit } of moneyPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * factor;
      quantities.push({ type: 'amount', value: val, unit, raw: m[0] });
    }
  }

  const durationPatterns = [
    { re: /(\d+(?:\.\d+)?)\s*个月/g, factor: 30, unit: '天' },
    { re: /(\d+(?:\.\d+)?)\s*年(?!限|龄)/g, factor: 365, unit: '天' },
    { re: /(\d+(?:\.\d+)?)\s*天/g, factor: 1, unit: '天' },
    { re: /(\d+(?:\.\d+)?)\s*日/g, factor: 1, unit: '天' }
  ];

  for (const { re, factor, unit } of durationPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = parseFloat(m[1]) * factor;
      quantities.push({ type: 'duration', value: val, unit, raw: m[0] });
    }
  }

  const percentPattern = /(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = percentPattern.exec(text)) !== null) {
    const val = parseFloat(m[1]);
    quantities.push({ type: 'percentage', value: val / 100, unit: '小数', raw: m[0] });
  }

  return quantities;
}

function extractBounds(text, quantities) {
  const lowerPatterns = ['不低于', '不少于', '至少', '最低', '下限', '>=', '≥', '高于'];
  const upperPatterns = ['不超过', '不高于', '至多', '最多', '上限', '<=', '≤', '小于', '不大于'];

  const bounds = { lower: null, upper: null };

  for (const qty of quantities) {
    const idx = text.indexOf(qty.raw);
    const context = text.substring(Math.max(0, idx - 12), idx);

    let hasLower = false;
    let hasUpper = false;

    for (const p of upperPatterns) {
      if (context.includes(p)) {
        hasUpper = true;
        break;
      }
    }

    if (!hasUpper) {
      for (const p of lowerPatterns) {
        if (context.includes(p)) {
          hasLower = true;
          break;
        }
      }
    }

    if (hasLower && !hasUpper) {
      if (bounds.lower === null || qty.value > bounds.lower) {
        bounds.lower = qty.value;
      }
    } else if (hasUpper && !hasLower) {
      if (bounds.upper === null || qty.value < bounds.upper) {
        bounds.upper = qty.value;
      }
    }
  }

  return bounds;
}

function detectContradiction(qtyA, qtyB, tagsA, tagsB, rule, textA, textB) {
  if (rule) {
    return { conflict_type: 'contradiction', severity: 'critical' };
  }

  const amountsA = qtyA.filter(q => q.type === 'amount');
  const amountsB = qtyB.filter(q => q.type === 'amount');

  if (amountsA.length > 0 && amountsB.length > 0) {
    const boundsA = extractBounds(textA, amountsA);
    const boundsB = extractBounds(textB, amountsB);

    if (boundsA.upper !== null && boundsB.lower !== null && boundsA.upper < boundsB.lower) {
      return { conflict_type: 'contradiction', severity: 'critical' };
    }
    if (boundsB.upper !== null && boundsA.lower !== null && boundsB.upper < boundsA.lower) {
      return { conflict_type: 'contradiction', severity: 'critical' };
    }
  }

  const durationsA = qtyA.filter(q => q.type === 'duration');
  const durationsB = qtyB.filter(q => q.type === 'duration');

  if (durationsA.length > 0 && durationsB.length > 0) {
    const boundsA = extractBounds(textA, durationsA);
    const boundsB = extractBounds(textB, durationsB);

    if (boundsA.upper !== null && boundsB.lower !== null && boundsA.upper < boundsB.lower) {
      return { conflict_type: 'contradiction', severity: 'critical' };
    }
    if (boundsB.upper !== null && boundsA.lower !== null && boundsB.upper < boundsA.lower) {
      return { conflict_type: 'contradiction', severity: 'critical' };
    }
  }

  return null;
}

function detectSameTagConflict(a, b, tag) {
  const qtyA = extractQuantities(a.body);
  const qtyB = extractQuantities(b.body);

  const result = detectContradiction(qtyA, qtyB, JSON.parse(a.tags), JSON.parse(b.tags), null, a.body, b.body);

  if (result) {
    return {
      ...result,
      reason: `条款"${a.title}"与条款"${b.title}"同属"${tag}"约束,量化约束存在逻辑矛盾(下限高于上限或方向相反),构成冲突。`
    };
  }

  return null;
}

function buildConflictReason(clauseA, clauseB, rule, conflictType) {
  const tagsA = JSON.parse(clauseA.tags);
  const tagsB = JSON.parse(clauseB.tags);
  if (conflictType === 'contradiction') {
    return `条款"${clauseA.title}"包含"${rule.tag_a}"约束(正文摘要: ${clauseA.body.substring(0, 60)}...),与条款"${clauseB.title}"包含的"${rule.tag_b}"约束(正文摘要: ${clauseB.body.substring(0, 60)}...)直接矛盾,构成冲突。`;
  }
  return `条款"${clauseA.title}"(标签: ${tagsA.join(',')})与条款"${clauseB.title}"(标签: ${tagsB.join(',')})在"${rule.tag_a}"与"${rule.tag_b}"上存在潜在重叠,建议审阅。`;
}

function detectConflicts(contractId, revision = 1, clausesInput = null) {
  const clauses = clausesInput || queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
  const conflictRules = queryAll('SELECT * FROM conflict_rules');

  const conflicts = [];
  const conflictPairs = new Set();

  for (let i = 0; i < clauses.length; i++) {
    for (let j = i + 1; j < clauses.length; j++) {
      const a = clauses[i];
      const b = clauses[j];

      const tagsA = JSON.parse(a.tags);
      const tagsB = JSON.parse(b.tags);

      for (const rule of conflictRules) {
        const aHasTagA = tagsA.includes(rule.tag_a);
        const bHasTagB = tagsB.includes(rule.tag_b);
        const aHasTagB = tagsA.includes(rule.tag_b);
        const bHasTagA = tagsB.includes(rule.tag_a);

        if ((aHasTagA && bHasTagB) || (aHasTagB && bHasTagA)) {
          const qtyA = extractQuantities(a.body);
          const qtyB = extractQuantities(b.body);

          const result = detectContradiction(qtyA, qtyB, tagsA, tagsB, rule, a.body, b.body);

          if (result) {
            const clauseWithA = (aHasTagA && bHasTagB) ? a : b;
            const clauseWithB = (aHasTagA && bHasTagB) ? b : a;

            const reason = buildConflictReason(clauseWithA, clauseWithB, rule, result.conflict_type);

            const pairKey = [a.clause_id, b.clause_id].sort().join('|');
            if (!conflictPairs.has(pairKey)) {
              conflictPairs.add(pairKey);
              conflicts.push({
                contract_id: contractId,
                clause_a_id: a.clause_id,
                clause_b_id: b.clause_id,
                conflict_type: result.conflict_type,
                severity: result.severity,
                reason
              });
            }
          } else {
            const pairKey = [a.clause_id, b.clause_id].sort().join('|');
            if (!conflictPairs.has(pairKey)) {
              conflictPairs.add(pairKey);
              conflicts.push({
                contract_id: contractId,
                clause_a_id: a.clause_id,
                clause_b_id: b.clause_id,
                conflict_type: 'ambiguity',
                severity: 'warning',
                reason: `条款"${a.title}"(标签: ${tagsA.join(',')})与条款"${b.title}"(标签: ${tagsB.join(',')})在"${rule.tag_a}"与"${rule.tag_b}"上存在潜在歧义,建议人工审阅确认。`
              });
            }
          }
          break;
        }
      }
    }
  }

  for (let i = 0; i < clauses.length; i++) {
    for (let j = i + 1; j < clauses.length; j++) {
      const a = clauses[i];
      const b = clauses[j];

      const pairKey = [a.clause_id, b.clause_id].sort().join('|');
      if (conflictPairs.has(pairKey)) continue;

      const tagsA = JSON.parse(a.tags);
      const tagsB = JSON.parse(b.tags);

      const commonTags = tagsA.filter(t => tagsB.includes(t));

      for (const tag of commonTags) {
        if (['liability_cap', 'payment_term', 'termination', 'confidentiality', 'transfer_restriction'].includes(tag)) {
          const sameTagConflict = detectSameTagConflict(a, b, tag);
          if (sameTagConflict) {
            conflictPairs.add(pairKey);
            conflicts.push({
              contract_id: contractId,
              clause_a_id: a.clause_id,
              clause_b_id: b.clause_id,
              conflict_type: sameTagConflict.conflict_type,
              severity: sameTagConflict.severity,
              reason: sameTagConflict.reason
            });
            break;
          }
        }
      }
    }
  }

  runSql('DELETE FROM detected_conflicts WHERE contract_id = ? AND revision = ?', [contractId, revision]);

  const inserted = [];
  for (const c of conflicts) {
    runSql(
      'INSERT INTO detected_conflicts (contract_id, clause_a_id, clause_b_id, conflict_type, severity, reason, revision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.contract_id, c.clause_a_id, c.clause_b_id, c.conflict_type, c.severity, c.reason, revision]
    );
    const row = queryOne('SELECT last_insert_rowid() as id');
    inserted.push({ ...c, id: row.id, revision });
  }

  return inserted;
}

module.exports = { extractQuantities, detectConflicts };
