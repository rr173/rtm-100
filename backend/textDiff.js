function lcs(arr1, arr2) {
  const m = arr1.length;
  const n = arr2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (arr1[i - 1] === arr2[j - 1]) {
      result.unshift({ type: 'unchanged', value: arr1[i - 1], index1: i - 1, index2: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      result.unshift({ type: 'deleted', value: arr1[i - 1], index1: i - 1 });
      i--;
    } else {
      result.unshift({ type: 'added', value: arr2[j - 1], index2: j - 1 });
      j--;
    }
  }

  while (i > 0) {
    result.unshift({ type: 'deleted', value: arr1[i - 1], index1: i - 1 });
    i--;
  }

  while (j > 0) {
    result.unshift({ type: 'added', value: arr2[j - 1], index2: j - 1 });
    j--;
  }

  return result;
}

function splitByPeriod(text) {
  const sentences = [];
  let current = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;
    
    if (char === '。' || char === '.' || char === '！' || char === '!' || char === '？' || char === '?') {
      if (current.trim()) {
        sentences.push(current.trim());
      }
      current = '';
    }
  }
  
  if (current.trim()) {
    sentences.push(current.trim());
  }
  
  return sentences;
}

function computeTextDiff(oldText, newText) {
  if (oldText === newText) {
    return {
      sentences: oldText ? splitByPeriod(oldText).map(s => ({ type: 'unchanged', value: s })) : [],
      summary: { added: 0, deleted: 0, unchanged: oldText ? splitByPeriod(oldText).length : 0 }
    };
  }

  const oldSentences = splitByPeriod(oldText || '');
  const newSentences = splitByPeriod(newText || '');

  const diffResult = lcs(oldSentences, newSentences);
  
  let added = 0, deleted = 0, unchanged = 0;
  for (const item of diffResult) {
    if (item.type === 'added') added++;
    else if (item.type === 'deleted') deleted++;
    else unchanged++;
  }

  return {
    sentences: diffResult,
    summary: { added, deleted, unchanged }
  };
}

function compareRevisions(oldClauses, newClauses) {
  const oldMap = new Map();
  const newMap = new Map();

  for (const c of oldClauses) {
    oldMap.set(c.clause_id, c);
  }
  for (const c of newClauses) {
    newMap.set(c.clause_id, c);
  }

  const allClauseIds = new Set([...oldMap.keys(), ...newMap.keys()]);
  const result = [];

  for (const clauseId of allClauseIds) {
    const oldClause = oldMap.get(clauseId);
    const newClause = newMap.get(clauseId);

    if (!oldClause && newClause) {
      result.push({
        clause_id: clauseId,
        status: 'added',
        old_body: null,
        new_body: newClause.body,
        old_tags: null,
        new_tags: newClause.tags,
        title: newClause.title,
        section: newClause.section,
        diff: null
      });
    } else if (oldClause && !newClause) {
      result.push({
        clause_id: clauseId,
        status: 'deleted',
        old_body: oldClause.body,
        new_body: null,
        old_tags: oldClause.tags,
        new_tags: null,
        title: oldClause.title,
        section: oldClause.section,
        diff: null
      });
    } else {
      const tagsChanged = JSON.stringify(oldClause.tags || []) !== JSON.stringify(newClause.tags || []);
      const bodyChanged = oldClause.body !== newClause.body;

      if (bodyChanged || tagsChanged) {
        result.push({
          clause_id: clauseId,
          status: 'modified',
          old_body: oldClause.body,
          new_body: newClause.body,
          old_tags: oldClause.tags,
          new_tags: newClause.tags,
          title: newClause.title,
          section: newClause.section,
          diff: computeTextDiff(oldClause.body, newClause.body)
        });
      } else {
        result.push({
          clause_id: clauseId,
          status: 'unchanged',
          old_body: oldClause.body,
          new_body: newClause.body,
          old_tags: oldClause.tags,
          new_tags: newClause.tags,
          title: newClause.title,
          section: newClause.section,
          diff: null
        });
      }
    }
  }

  const sortedResult = result.sort((a, b) => {
    const sectionOrder = a.section.localeCompare(b.section);
    if (sectionOrder !== 0) return sectionOrder;
    return a.clause_id.localeCompare(b.clause_id);
  });

  let addedCount = 0, deletedCount = 0, modifiedCount = 0, unchangedCount = 0;
  for (const r of sortedResult) {
    if (r.status === 'added') addedCount++;
    else if (r.status === 'deleted') deletedCount++;
    else if (r.status === 'modified') modifiedCount++;
    else unchangedCount++;
  }

  return {
    comparisons: sortedResult,
    summary: {
      added: addedCount,
      deleted: deletedCount,
      modified: modifiedCount,
      unchanged: unchangedCount,
      total: sortedResult.length
    }
  };
}

module.exports = { lcs, computeTextDiff, compareRevisions, splitByPeriod };
