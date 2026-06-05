const { queryAll, runSql } = require('./database');

const CHINESE_NUM_MAP = {
  '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  '十': 10, '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15, '十六': 16, '十七': 17, '十八': 18, '十九': 19,
  '二十': 20, '二十一': 21, '二十二': 22, '二十三': 23, '二十四': 24, '二十五': 25, '二十六': 26, '二十七': 27, '二十八': 28, '二十九': 29,
  '三十': 30, '三十一': 31, '三十二': 32, '三十三': 33, '三十四': 34, '三十五': 35, '三十六': 36, '三十七': 37, '三十八': 38, '三十九': 39,
  '四十': 40, '四十一': 41, '四十二': 42, '四十三': 43, '四十四': 44, '四十五': 45, '四十六': 46, '四十七': 47, '四十八': 48, '四十九': 49,
  '五十': 50, '五十一': 51, '五十二': 52, '五十三': 53, '五十四': 54, '五十五': 55, '五十六': 56, '五十七': 57, '五十八': 58, '五十九': 59,
  '六十': 60, '六十一': 61, '六十二': 62, '六十三': 63, '六十四': 64, '六十五': 65, '六十六': 66, '六十七': 67, '六十八': 68, '六十九': 69,
  '七十': 70, '七十一': 71, '七十二': 72, '七十三': 73, '七十四': 74, '七十五': 75, '七十六': 76, '七十七': 77, '七十八': 78, '七十九': 79,
  '八十': 80, '八十一': 81, '八十二': 82, '八十三': 83, '八十四': 84, '八十五': 85, '八十六': 86, '八十七': 87, '八十八': 88, '八十九': 89,
  '九十': 90, '九十一': 91, '九十二': 92, '九十三': 93, '九十四': 94, '九十五': 95, '九十六': 96, '九十七': 97, '九十八': 98, '九十九': 99,
  '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9
};

function chineseToNumber(chinese) {
  if (!chinese) return null;
  
  if (CHINESE_NUM_MAP[chinese] !== undefined) {
    return CHINESE_NUM_MAP[chinese];
  }
  
  if (/^\d+$/.test(chinese)) {
    const num = parseInt(chinese, 10);
    return num >= 1 && num <= 99 ? num : null;
  }
  
  let result = 0;
  let temp = 0;
  
  for (let i = 0; i < chinese.length; i++) {
    const char = chinese[i];
    const charValue = CHINESE_NUM_MAP[char];
    
    if (charValue === undefined) continue;
    
    if (char === '十') {
      temp = temp === 0 ? 10 : temp * 10;
    } else if (char === '百') {
      temp = temp * 100;
    } else {
      temp += charValue;
    }
  }
  
  result = temp;
  
  return result >= 1 && result <= 99 ? result : null;
}

function numberToClauseId(num) {
  if (num < 1 || num > 99) return null;
  return `C${num.toString().padStart(2, '0')}`;
}

function extractContext(text, matchIndex, matchLength, contextLength = 10) {
  const start = Math.max(0, matchIndex - contextLength);
  const end = Math.min(text.length, matchIndex + matchLength + contextLength);
  return text.substring(start, end);
}

function findClauseReferences(clauseBody, validClauseIds) {
  const references = [];
  const validClauseSet = new Set(validClauseIds);
  
  const cIdPattern = /(参照|依据|见|按照|根据|参见)?\s*(C\d{2})(?!\d)/g;
  let match;
  while ((match = cIdPattern.exec(clauseBody)) !== null) {
    const clauseId = match[2];
    if (validClauseSet.has(clauseId)) {
      references.push({
        to_clause_id: clauseId,
        context: extractContext(clauseBody, match.index, match[0].length),
        match_index: match.index
      });
    }
  }
  
  const tiaoPattern = /(第[一二三四五六七八九十百零\d]+[条款])(?!\d)/g;
  while ((match = tiaoPattern.exec(clauseBody)) !== null) {
    const fullMatch = match[0];
    const numMatch = fullMatch.match(/第(.+?)[条款]/);
    if (numMatch) {
      const num = chineseToNumber(numMatch[1]);
      if (num) {
        const clauseId = numberToClauseId(num);
        if (clauseId && validClauseSet.has(clauseId)) {
          const existing = references.find(r => r.to_clause_id === clauseId && 
            Math.abs(r.match_index - match.index) < 5);
          if (!existing) {
            references.push({
              to_clause_id: clauseId,
              context: extractContext(clauseBody, match.index, match[0].length),
              match_index: match.index
            });
          }
        }
      }
    }
  }
  
  const prefixPattern = /(参照|依据|见|按照|根据|参见)\s*第?([一二三四五六七八九十百零\d]+)[条款]?/g;
  while ((match = prefixPattern.exec(clauseBody)) !== null) {
    const num = chineseToNumber(match[2]);
    if (num) {
      const clauseId = numberToClauseId(num);
      if (clauseId && validClauseSet.has(clauseId)) {
        const existing = references.find(r => r.to_clause_id === clauseId && 
          Math.abs(r.match_index - match.index) < 5);
        if (!existing) {
          references.push({
            to_clause_id: clauseId,
            context: extractContext(clauseBody, match.index, match[0].length),
            match_index: match.index
          });
        }
      }
    }
  }
  
  return references;
}

function analyzeDependencies(contractId, revision, clauses) {
  const clauseIds = clauses.map(c => c.clause_id || c.id);
  const deps = [];
  
  for (const clause of clauses) {
    const fromClauseId = clause.clause_id || clause.id;
    const body = clause.body || '';
    const references = findClauseReferences(body, clauseIds);
    
    for (const ref of references) {
      if (ref.to_clause_id !== fromClauseId) {
        const existing = deps.find(d => 
          d.from_clause_id === fromClauseId && 
          d.to_clause_id === ref.to_clause_id
        );
        if (!existing) {
          deps.push({
            contract_id: contractId,
            revision: revision,
            from_clause_id: fromClauseId,
            to_clause_id: ref.to_clause_id,
            context: ref.context
          });
        }
      }
    }
  }
  
  return deps;
}

function saveDependencies(deps) {
  if (deps.length === 0) return 0;
  
  const contractId = deps[0].contract_id;
  const revision = deps[0].revision;
  
  runSql(
    'DELETE FROM contract_deps WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );
  
  let count = 0;
  for (const dep of deps) {
    try {
      runSql(
        'INSERT INTO contract_deps (contract_id, revision, from_clause_id, to_clause_id, context) VALUES (?, ?, ?, ?, ?)',
        [dep.contract_id, dep.revision, dep.from_clause_id, dep.to_clause_id, dep.context]
      );
      count++;
    } catch (e) {
    }
  }
  
  return count;
}

function getDependencies(contractId, revision) {
  return queryAll(
    'SELECT * FROM contract_deps WHERE contract_id = ? AND revision = ?',
    [contractId, revision]
  );
}

function getImpactAnalysis(contractId, revision, targetClauseId) {
  const deps = getDependencies(contractId, revision);
  
  const reverseGraph = {};
  for (const dep of deps) {
    if (!reverseGraph[dep.to_clause_id]) {
      reverseGraph[dep.to_clause_id] = [];
    }
    reverseGraph[dep.to_clause_id].push(dep.from_clause_id);
  }
  
  const visited = new Set();
  const queue = [];
  const direct = [];
  const indirect = [];
  const MAX_NODES = 50;
  
  if (reverseGraph[targetClauseId]) {
    for (const neighbor of reverseGraph[targetClauseId]) {
      if (!visited.has(neighbor) && visited.size < MAX_NODES) {
        visited.add(neighbor);
        queue.push({ id: neighbor, level: 1 });
        direct.push(neighbor);
      }
    }
  }
  
  while (queue.length > 0 && visited.size < MAX_NODES) {
    const { id, level } = queue.shift();
    
    if (reverseGraph[id]) {
      for (const neighbor of reverseGraph[id]) {
        if (!visited.has(neighbor) && visited.size < MAX_NODES) {
          visited.add(neighbor);
          queue.push({ id: neighbor, level: level + 1 });
          if (level >= 1) {
            indirect.push(neighbor);
          }
        }
      }
    }
  }
  
  return {
    direct: direct,
    indirect: indirect,
    total_affected: direct.length + indirect.length
  };
}

function getModifiedClauseImpact(contractId, oldRevision, newRevision, modifiedClauseIds) {
  const oldDeps = getDependencies(contractId, oldRevision);
  const newDeps = getDependencies(contractId, newRevision);
  
  const reverseGraph = {};
  const allDeps = [...oldDeps, ...newDeps];
  
  for (const dep of allDeps) {
    if (!reverseGraph[dep.to_clause_id]) {
      reverseGraph[dep.to_clause_id] = new Set();
    }
    reverseGraph[dep.to_clause_id].add(dep.from_clause_id);
  }
  
  const affectedClauses = new Set();
  const MAX_NODES = 50;
  
  for (const clauseId of modifiedClauseIds) {
    const visited = new Set();
    const queue = [];
    
    if (reverseGraph[clauseId]) {
      for (const neighbor of reverseGraph[clauseId]) {
        if (!visited.has(neighbor) && visited.size < MAX_NODES) {
          visited.add(neighbor);
          queue.push(neighbor);
          affectedClauses.add(neighbor);
        }
      }
    }
    
    while (queue.length > 0 && visited.size < MAX_NODES) {
      const id = queue.shift();
      
      if (reverseGraph[id]) {
        for (const neighbor of reverseGraph[id]) {
          if (!visited.has(neighbor) && visited.size < MAX_NODES) {
            visited.add(neighbor);
            queue.push(neighbor);
            affectedClauses.add(neighbor);
          }
        }
      }
    }
  }
  
  return Array.from(affectedClauses);
}

module.exports = {
  chineseToNumber,
  numberToClauseId,
  findClauseReferences,
  analyzeDependencies,
  saveDependencies,
  getDependencies,
  getImpactAnalysis,
  getModifiedClauseImpact
};
