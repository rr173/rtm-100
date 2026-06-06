const { queryAll, queryOne, runSql } = require('./database');

function buildChar2Grams(text) {
  const grams = [];
  if (!text || text.length < 2) {
    return grams;
  }
  const cleaned = text.replace(/\s+/g, '');
  for (let i = 0; i < cleaned.length - 1; i++) {
    grams.push(cleaned.substring(i, i + 2));
  }
  return grams;
}

function computeTF(grams) {
  const tf = {};
  const total = grams.length;
  if (total === 0) return tf;
  for (const g of grams) {
    tf[g] = (tf[g] || 0) + 1;
  }
  for (const k of Object.keys(tf)) {
    tf[k] = tf[k] / total;
  }
  return tf;
}

function computeIDF(allClauseGrams) {
  const docFreq = {};
  const totalDocs = allClauseGrams.length;
  for (const grams of allClauseGrams) {
    const seen = new Set(grams);
    for (const g of seen) {
      docFreq[g] = (docFreq[g] || 0) + 1;
    }
  }
  const idf = {};
  for (const term of Object.keys(docFreq)) {
    idf[term] = Math.log((totalDocs) / (docFreq[term]));
  }
  return idf;
}

function computeTFIDFVector(tf, idf) {
  const vector = {};
  for (const term of Object.keys(tf)) {
    if (idf[term] !== undefined) {
      vector[term] = tf[term] * idf[term];
    }
  }
  return vector;
}

function cosineSimilarity(vecA, vecB) {
  const keysA = Object.keys(vecA);
  if (keysA.length === 0) return 0;

  let dotProduct = 0;
  for (const k of keysA) {
    if (vecB[k] !== undefined) {
      dotProduct += vecA[k] * vecB[k];
    }
  }

  let normA = 0;
  for (const k of keysA) {
    normA += vecA[k] * vecA[k];
  }
  normA = Math.sqrt(normA);
  if (normA === 0) return 0;

  let normB = 0;
  const keysB = Object.keys(vecB);
  for (const k of keysB) {
    normB += vecB[k] * vecB[k];
  }
  normB = Math.sqrt(normB);
  if (normB === 0) return 0;

  return dotProduct / (normA * normB);
}

function getMatchedTerms(queryVector, docVector) {
  const matched = [];
  for (const term of Object.keys(queryVector)) {
    if (docVector[term] !== undefined) {
      matched.push(term);
    }
  }
  return matched;
}

function buildIndex(contractId) {
  let clauses;
  if (contractId) {
    clauses = queryAll(
      'SELECT * FROM clauses WHERE contract_id = ?',
      [contractId]
    );
    runSql('DELETE FROM search_index WHERE contract_id = ?', [contractId]);
  } else {
    clauses = queryAll('SELECT * FROM clauses');
    runSql('DELETE FROM search_index');
  }

  if (clauses.length === 0) {
    return { indexed_clauses_count: 0, total_terms: 0 };
  }

  const allClauseGrams = [];
  const clauseGramsMap = [];
  for (const c of clauses) {
    const grams = buildChar2Grams(c.title + ' ' + c.body);
    allClauseGrams.push(grams);
    clauseGramsMap.push({ clause: c, grams });
  }

  const idf = computeIDF(allClauseGrams);
  const totalTerms = Object.keys(idf).length;

  let indexedCount = 0;
  for (const { clause, grams } of clauseGramsMap) {
    const tf = computeTF(grams);
    const vector = computeTFIDFVector(tf, idf);
    const vectorJson = JSON.stringify(vector);
    const termsCount = Object.keys(vector).length;

    runSql(
      `INSERT OR REPLACE INTO search_index 
       (contract_id, clause_id, vector_json, terms_count, indexed_at) 
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [clause.contract_id, clause.clause_id, vectorJson, termsCount]
    );
    indexedCount++;
  }

  return { indexed_clauses_count: indexedCount, total_terms: totalTerms };
}

function searchSimilar(text, topK, minScore, excludeContractId) {
  const queryGrams = buildChar2Grams(text);
  const queryTF = computeTF(queryGrams);

  const allRows = queryAll('SELECT * FROM search_index');
  if (allRows.length === 0) {
    return { results: [], query_terms_count: Object.keys(queryTF).length };
  }

  const allClauseGrams = [];
  const parsedVectors = [];
  for (const row of allRows) {
    const vec = JSON.parse(row.vector_json);
    parsedVectors.push({ row, vec });
    const grams = Object.keys(vec);
    allClauseGrams.push(grams);
  }

  const idf = computeIDF(allClauseGrams);
  const queryVector = computeTFIDFVector(queryTF, idf);
  const queryTermsCount = Object.keys(queryVector).length;

  const scores = [];
  for (const { row, vec } of parsedVectors) {
    if (excludeContractId && parseInt(row.contract_id) === parseInt(excludeContractId)) {
      continue;
    }
    const score = cosineSimilarity(queryVector, vec);
    if (score >= minScore) {
      const matched = getMatchedTerms(queryVector, vec);
      scores.push({
        contract_id: row.contract_id,
        clause_id: row.clause_id,
        score,
        matched_terms: matched,
        _vec: vec
      });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const topResults = scores.slice(0, topK);

  const results = [];
  for (const r of topResults) {
    const clause = queryOne(
      'SELECT title, body FROM clauses WHERE contract_id = ? AND clause_id = ?',
      [r.contract_id, r.clause_id]
    );
    results.push({
      contract_id: r.contract_id,
      clause_id: r.clause_id,
      title: clause ? clause.title : '',
      body: clause ? clause.body : '',
      score: r.score,
      matched_terms: r.matched_terms
    });
  }

  return { results, query_terms_count: queryTermsCount };
}

function detectPlagiarism(contractId, threshold) {
  const contract = queryOne('SELECT * FROM contracts WHERE id = ?', [contractId]);
  if (!contract) {
    throw new Error('合同不存在');
  }

  const targetClauses = queryAll(
    'SELECT * FROM clauses WHERE contract_id = ?',
    [contractId]
  );

  const allRows = queryAll('SELECT * FROM search_index');
  if (allRows.length === 0) {
    return { suspicious_pairs: [], total_checked: targetClauses.length, suspicious_count: 0 };
  }

  const clauseMap = {};
  const allClauseGrams = [];
  const parsedVectors = [];

  for (const row of allRows) {
    const vec = JSON.parse(row.vector_json);
    parsedVectors.push({ row, vec });
    clauseMap[`${row.contract_id}_${row.clause_id}`] = vec;
    allClauseGrams.push(Object.keys(vec));
  }

  const idf = computeIDF(allClauseGrams);

  const suspiciousPairs = [];
  let totalChecked = 0;

  for (const tc of targetClauses) {
    totalChecked++;
    const grams = buildChar2Grams(tc.title + ' ' + tc.body);
    const tf = computeTF(grams);
    const queryVector = computeTFIDFVector(tf, idf);

    for (const { row, vec } of parsedVectors) {
      if (parseInt(row.contract_id) === parseInt(contractId)) {
        continue;
      }
      const score = cosineSimilarity(queryVector, vec);
      if (score >= threshold) {
        const otherClause = queryOne(
          'SELECT title, body FROM clauses WHERE contract_id = ? AND clause_id = ?',
          [row.contract_id, row.clause_id]
        );
        suspiciousPairs.push({
          clause_id: tc.clause_id,
          similar_to: {
            contract_id: row.contract_id,
            clause_id: row.clause_id,
            title: otherClause ? otherClause.title : ''
          },
          score
        });
      }
    }
  }

  return {
    suspicious_pairs: suspiciousPairs,
    total_checked: totalChecked,
    suspicious_count: suspiciousPairs.length
  };
}

module.exports = {
  buildIndex,
  searchSimilar,
  detectPlagiarism,
  buildChar2Grams,
  computeTF,
  computeIDF,
  computeTFIDFVector,
  cosineSimilarity
};
