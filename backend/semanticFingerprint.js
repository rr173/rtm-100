const { queryAll, queryOne, runSql } = require('./database');

const SUBJECT_PATTERNS = ['甲方', '乙方', '双方', '任何一方', '违约方', '守约方', '一方', '各方', '披露方', '接收方'];
const MODAL_PATTERNS = ['应当', '必须', '可以', '不得', '有权', '无权', '应', '须', '可'];

const CORE_VERBS = [
  '支付', '承担', '履行', '提供', '赔偿', '通知', '披露', '保密',
  '终止', '转让', '解除', '签订', '提交', '出具', '保证', '承诺',
  '确认', '同意', '接受', '拒绝', '变更', '修改', '续签', '放弃',
  '主张', '行使', '负责', '配合', '协助', '遵守', '执行', '解决',
  '提起诉讼', '交付', '返还', '补偿', '授权',
  '许可', '禁止', '允许', '继续履行', '中止', '恢复', '撤销', '免除',
  '减免', '延长', '缩短', '提前', '推迟', '按期支付', '诉讼',
  '电汇', '转账', '汇款', '付款', '缴纳', '交纳', '赔付', '偿付'
];

const OBJECT_MARKERS = ['至', '到', '于', '给', '向', '对', '与', '为'];

const MAX_ACTION_LEN = 8;
const MAX_OBJECT_LEN = 12;

function isCoreVerbAt(text, pos) {
  for (const verb of CORE_VERBS) {
    if (text.slice(pos, pos + verb.length) === verb) {
      return verb;
    }
  }
  return null;
}

function findCoreVerbs(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    const verb = isCoreVerbAt(text, i);
    if (verb) {
      results.push({ verb, index: i });
      i += verb.length;
    } else {
      i++;
    }
  }
  return results;
}

function isEmbeddedVerb(text, verbIndex) {
  const before = text.slice(Math.max(0, verbIndex - 10), verbIndex);
  if (/[甲乙双任一各违约守披露接收]方/.test(before)) return true;
  if (/对方/.test(before)) return true;
  if (before.endsWith('的')) return true;
  if (before.endsWith('所')) return true;
  if (before.endsWith('出具')) return true;
  if (before.endsWith('收到')) return true;
  return false;
}

function findBestVerb(text) {
  const verbs = findCoreVerbs(text);
  if (verbs.length === 0) return null;

  for (const v of verbs) {
    if (isEmbeddedVerb(text, v.index)) continue;

    const after = text.slice(v.index + v.verb.length, v.index + v.verb.length + 5);
    for (const marker of OBJECT_MARKERS) {
      if (after.includes(marker)) {
        return v;
      }
    }
  }

  for (const v of verbs) {
    if (!isEmbeddedVerb(text, v.index)) {
      return v;
    }
  }

  return verbs[0];
}

function cleanSegment(seg) {
  if (!seg) return '';
  let s = seg.trim();
  while (s.length > 0 && '的地得将把在对向与'.includes(s[0])) {
    s = s.slice(1).trim();
  }
  while (s.length > 0 && '的地得'.includes(s[s.length - 1])) {
    s = s.slice(0, -1).trim();
  }
  return s;
}

function extractObject(afterVerb) {
  let startIdx = 0;
  while (startIdx < afterVerb.length) {
    const ch = afterVerb[startIdx];
    if (/[，,。.！？；;、：:]/.test(ch)) return '';
    if (OBJECT_MARKERS.includes(ch)) {
      startIdx++;
      continue;
    }
    break;
  }

  let endIdx = startIdx;
  let count = 0;
  while (endIdx < afterVerb.length && count < MAX_OBJECT_LEN) {
    const ch = afterVerb[endIdx];
    if (/[，,。.！？；;、：:]/.test(ch)) break;
    if (OBJECT_MARKERS.includes(ch)) break;
    endIdx++;
    count++;
  }

  let obj = afterVerb.slice(startIdx, endIdx);
  const commaIdx = obj.search(/[，,。.！？；;、：:]/);
  if (commaIdx !== -1) obj = obj.slice(0, commaIdx);

  obj = cleanSegment(obj);

  const badPatterns = ['期限为', '时间为', '金额为', '条件为', '方式为', '地点为', '范围为'];
  for (const p of badPatterns) {
    if (obj.startsWith(p)) {
      obj = obj.slice(p.length);
    }
  }
  obj = cleanSegment(obj);

  if (obj.length > MAX_OBJECT_LEN) obj = obj.slice(0, MAX_OBJECT_LEN);
  obj = cleanSegment(obj);
  return obj;
}

function extractActionAndObject(afterVerb, verbText) {
  let actionText = verbText;
  let remainingAfterVerb = afterVerb.slice(verbText.length);

  let extendedIdx = 0;
  let count = 0;
  while (extendedIdx < remainingAfterVerb.length && count < 2 && actionText.length < MAX_ACTION_LEN) {
    const ch = remainingAfterVerb[extendedIdx];
    if (/[，,。.！？；;、：:]/.test(ch)) break;
    if (OBJECT_MARKERS.includes(ch)) break;
    if ('服务费用款项违约金金额期限责任义务信息资料文件证明合同协议款项'.includes(ch) && count === 0) {
      break;
    }
    extendedIdx++;
    count++;
  }

  if (extendedIdx > 0) {
    const ext = cleanSegment(remainingAfterVerb.slice(0, extendedIdx));
    if (ext.length > 0 && (actionText + ext).length <= MAX_ACTION_LEN) {
      actionText = actionText + ext;
    }
  }

  if (actionText.length > MAX_ACTION_LEN) {
    actionText = actionText.slice(0, MAX_ACTION_LEN);
  }

  const rest = remainingAfterVerb.slice(extendedIdx);
  const objectText = extractObject(rest);

  return { action: actionText, object: objectText };
}

function extractTriples(text) {
  if (!text || typeof text !== 'string') return [];

  const triples = [];
  const sentences = text.split(/[。！？；\n]/).map(s => s.trim()).filter(s => s.length > 0);

  for (const sentence of sentences) {
    for (const subject of SUBJECT_PATTERNS) {
      const modalGroup = MODAL_PATTERNS.join('|');
      const subjectRegex = new RegExp(subject + '(' + modalGroup + ')', 'g');
      let match;
      while ((match = subjectRegex.exec(sentence)) !== null) {
        const subjectMatch = match[0];
        const modal = match[1];
        const afterModal = sentence.slice(match.index + subjectMatch.length);

        if (afterModal.length === 0) continue;

        const bestVerb = findBestVerb(afterModal);
        if (!bestVerb) continue;

        const afterVerb = afterModal.slice(bestVerb.index);
        const { action, object } = extractActionAndObject(afterVerb, bestVerb.verb);

        if (action.length === 0 || object.length === 0) continue;

        triples.push({
          subject: subject,
          action: action,
          object: object
        });
      }
    }
  }

  const seen = new Set();
  const uniqueTriples = [];
  for (const t of triples) {
    const key = `${t.subject}|${t.action}|${t.object}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTriples.push(t);
    }
  }

  return uniqueTriples;
}

function tripleToKey(t) {
  return `${t.subject}|${t.action}|${t.object}`;
}

function getClausesForRevision(contractId, revision) {
  if (revision === 1) {
    const currentClauses = queryAll('SELECT * FROM clauses WHERE contract_id = ?', [contractId]);
    return currentClauses.map(c => ({
      clause_id: c.clause_id,
      section: c.section,
      title: c.title,
      body: c.body,
      tags: JSON.parse(c.tags)
    }));
  } else {
    const revisionData = queryOne(
      'SELECT clauses_json FROM contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractId, revision]
    );
    if (!revisionData) return null;
    return JSON.parse(revisionData.clauses_json);
  }
}

function getMaxRevision(contractId) {
  const maxRev = queryOne(
    'SELECT MAX(revision_number) as max_rev FROM contract_revisions WHERE contract_id = ?',
    [contractId]
  );
  return maxRev?.max_rev || 1;
}

function generateFingerprint(contractId, revision) {
  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    return { error: '合同不存在', status: 404 };
  }

  const targetRevision = revision || getMaxRevision(contractId);
  const clauses = getClausesForRevision(contractId, targetRevision);

  if (!clauses) {
    return { error: '指定版本不存在', status: 404 };
  }

  runSql(
    'DELETE FROM semantic_triples WHERE contract_id = ? AND revision = ?',
    [contractId, targetRevision]
  );

  let totalTriples = 0;
  const details = [];

  for (const clause of clauses) {
    const triples = extractTriples(clause.body);
    details.push({
      clause_id: clause.clause_id,
      triples: triples
    });

    for (const t of triples) {
      runSql(
        'INSERT INTO semantic_triples (contract_id, revision, clause_id, subject, action, object) VALUES (?, ?, ?, ?, ?, ?)',
        [contractId, targetRevision, clause.clause_id, t.subject, t.action, t.object]
      );
      totalTriples++;
    }
  }

  return {
    clauses_processed: clauses.length,
    total_triples: totalTriples,
    details: details
  };
}

function getFingerprintFromDb(contractId, revision) {
  const rows = queryAll(
    'SELECT clause_id, subject, action, object FROM semantic_triples WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );

  const map = {};
  for (const row of rows) {
    if (!map[row.clause_id]) {
      map[row.clause_id] = [];
    }
    map[row.clause_id].push({
      subject: row.subject,
      action: row.action,
      object: row.object
    });
  }
  return map;
}

function buildDiffSummary(oldTriples, newTriples) {
  const oldSet = new Set(oldTriples.map(tripleToKey));
  const newSet = new Set(newTriples.map(tripleToKey));

  const added = newTriples.filter(t => !oldSet.has(tripleToKey(t)));
  const removed = oldTriples.filter(t => !newSet.has(tripleToKey(t)));

  return {
    added_triples: added,
    removed_triples: removed,
    common_count: oldTriples.length - removed.length
  };
}

function semanticDiff(contractId, fromRevision, toRevision) {
  if (!fromRevision || !toRevision) {
    return { error: 'from_revision和to_revision为必填项', status: 400 };
  }
  if (fromRevision >= toRevision) {
    return { error: 'from_revision必须小于to_revision', status: 400 };
  }

  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    return { error: '合同不存在', status: 404 };
  }

  let fromFingerprint = getFingerprintFromDb(contractId, fromRevision);
  let toFingerprint = getFingerprintFromDb(contractId, toRevision);

  const fromClauses = getClausesForRevision(contractId, fromRevision);
  const toClauses = getClausesForRevision(contractId, toRevision);

  if (!fromClauses || !toClauses) {
    return { error: '指定的版本不存在', status: 404 };
  }

  if (Object.keys(fromFingerprint).length === 0) {
    const fp = generateFingerprint(contractId, fromRevision);
    if (fp.error) return fp;
    fromFingerprint = getFingerprintFromDb(contractId, fromRevision);
  }
  if (Object.keys(toFingerprint).length === 0) {
    const fp = generateFingerprint(contractId, toRevision);
    if (fp.error) return fp;
    toFingerprint = getFingerprintFromDb(contractId, toRevision);
  }

  const allClauseIds = new Set([
    ...Object.keys(fromFingerprint),
    ...Object.keys(toFingerprint)
  ]);

  const changes = [];
  let unchangedCount = 0;
  let wordingCount = 0;
  let semanticCount = 0;

  for (const clauseId of allClauseIds) {
    const oldTriples = fromFingerprint[clauseId] || [];
    const newTriples = toFingerprint[clauseId] || [];

    const oldKeys = new Set(oldTriples.map(tripleToKey));
    const newKeys = new Set(newTriples.map(tripleToKey));

    let changeType;
    if (oldKeys.size === 0 && newKeys.size === 0) {
      changeType = 'unchanged';
    } else if (oldKeys.size === newKeys.size && [...oldKeys].every(k => newKeys.has(k))) {
      changeType = 'unchanged';
    } else {
      let intersectionSize = 0;
      for (const k of oldKeys) {
        if (newKeys.has(k)) intersectionSize++;
      }
      if (intersectionSize === 0) {
        changeType = 'semantic_change';
      } else {
        changeType = 'wording_change';
      }
    }

    if (changeType === 'unchanged') unchangedCount++;
    else if (changeType === 'wording_change') wordingCount++;
    else semanticCount++;

    changes.push({
      clause_id: clauseId,
      change_type: changeType,
      old_triples: oldTriples,
      new_triples: newTriples,
      diff_summary: buildDiffSummary(oldTriples, newTriples)
    });
  }

  changes.sort((a, b) => a.clause_id.localeCompare(b.clause_id));

  return {
    changes: changes,
    stats: {
      unchanged: unchangedCount,
      wording_change: wordingCount,
      semantic_change: semanticCount
    }
  };
}

function getEvolutionChain(contractId, clauseId) {
  if (!clauseId) {
    return { error: 'clause_id为必填项', status: 400 };
  }

  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    return { error: '合同不存在', status: 404 };
  }

  const revisionRows = queryAll(
    'SELECT DISTINCT revision_number FROM contract_revisions WHERE contract_id = ? ORDER BY revision_number ASC',
    [contractId]
  );

  let revisionList;
  if (revisionRows.length === 0) {
    revisionList = [1];
  } else {
    revisionList = revisionRows.map(r => r.revision_number);
    if (!revisionList.includes(1)) {
      revisionList.unshift(1);
    }
    revisionList.sort((a, b) => a - b);
  }

  const chain = [];

  for (let i = 0; i < revisionList.length; i++) {
    const revision = revisionList[i];

    let fingerprint = getFingerprintFromDb(contractId, revision);
    if (!fingerprint[clauseId]) {
      const clauses = getClausesForRevision(contractId, revision);
      if (clauses) {
        const clause = clauses.find(c => c.clause_id === clauseId);
        if (clause) {
          const fp = generateFingerprint(contractId, revision);
          if (!fp.error) {
            fingerprint = getFingerprintFromDb(contractId, revision);
          }
        }
      }
    }

    const triples = fingerprint[clauseId] || [];

    let changeFromPrevious;
    if (i === 0) {
      changeFromPrevious = 'initial';
    } else {
      const prevRevision = revisionList[i - 1];
      const prevFingerprint = getFingerprintFromDb(contractId, prevRevision);
      const prevTriples = prevFingerprint[clauseId] || [];

      const oldKeys = new Set(prevTriples.map(tripleToKey));
      const newKeys = new Set(triples.map(tripleToKey));

      if (oldKeys.size === newKeys.size && [...oldKeys].every(k => newKeys.has(k))) {
        changeFromPrevious = 'unchanged';
      } else {
        let intersectionSize = 0;
        for (const k of oldKeys) {
          if (newKeys.has(k)) intersectionSize++;
        }
        if (intersectionSize === 0) {
          changeFromPrevious = 'semantic_change';
        } else {
          changeFromPrevious = 'wording_change';
        }
      }
    }

    chain.push({
      revision: revision,
      triples: triples,
      change_from_previous: changeFromPrevious
    });
  }

  return {
    clause_id: clauseId,
    chain: chain
  };
}

module.exports = {
  extractTriples,
  generateFingerprint,
  semanticDiff,
  getEvolutionChain,
  tripleToKey
};
