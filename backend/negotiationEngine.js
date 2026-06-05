const { queryAll, queryOne, runSql } = require('./database');

const STRATEGY_COEFFICIENTS = {
  balanced: 0.3,
  aggressive: 0.15,
  conservative: 0.5
};

const DIRECTION_CONFIG = {
  amount: { partyA: 'higher', partyB: 'lower' },
  percentage: { partyA: 'higher', partyB: 'lower' },
  duration: { partyA: 'higher', partyB: 'lower' }
};

function savePositions(contractId, party, positions) {
  for (const pos of positions) {
    const existing = queryOne(
      'SELECT id FROM negotiation_positions WHERE contract_id = ? AND party = ? AND clause_id = ? AND aspect = ?',
      [contractId, party, pos.clause_id, pos.aspect]
    );

    if (existing) {
      runSql(
        `UPDATE negotiation_positions 
         SET bottom_line = ?, ideal = ?, weight = ?, created_at = datetime('now')
         WHERE id = ?`,
        [pos.bottom_line, pos.ideal, pos.weight, existing.id]
      );
    } else {
      runSql(
        `INSERT INTO negotiation_positions 
         (contract_id, party, clause_id, aspect, bottom_line, ideal, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [contractId, party, pos.clause_id, pos.aspect, pos.bottom_line, pos.ideal, pos.weight]
      );
    }
  }

  return getPositions(contractId);
}

function getPositions(contractId) {
  const positions = queryAll(
    'SELECT * FROM negotiation_positions WHERE contract_id = ?',
    [contractId]
  );

  const result = {
    contract_id: contractId,
    party_a: [],
    party_b: []
  };

  for (const pos of positions) {
    const item = {
      clause_id: pos.clause_id,
      aspect: pos.aspect,
      bottom_line: pos.bottom_line,
      ideal: pos.ideal,
      weight: pos.weight
    };

    if (pos.party === '甲方') {
      result.party_a.push(item);
    } else {
      result.party_b.push(item);
    }
  }

  return result;
}

function calculateNegotiationSpace(contractId) {
  const positions = getPositions(contractId);
  const result = [];

  const clauseAspectMap = {};
  for (const pos of positions.party_a) {
    const key = `${pos.clause_id}_${pos.aspect}`;
    if (!clauseAspectMap[key]) {
      clauseAspectMap[key] = { clause_id: pos.clause_id, aspect: pos.aspect };
    }
    clauseAspectMap[key].party_a = pos;
  }
  for (const pos of positions.party_b) {
    const key = `${pos.clause_id}_${pos.aspect}`;
    if (!clauseAspectMap[key]) {
      clauseAspectMap[key] = { clause_id: pos.clause_id, aspect: pos.aspect };
    }
    clauseAspectMap[key].party_b = pos;
  }

  for (const key in clauseAspectMap) {
    const item = clauseAspectMap[key];
    if (!item.party_a || !item.party_b) continue;

    const analysis = analyzeSpace(item.party_a, item.party_b, item.aspect);
    result.push({
      clause_id: item.clause_id,
      aspect: item.aspect,
      party_a: {
        bottom_line: item.party_a.bottom_line,
        ideal: item.party_a.ideal,
        weight: item.party_a.weight
      },
      party_b: {
        bottom_line: item.party_b.bottom_line,
        ideal: item.party_b.ideal,
        weight: item.party_b.weight
      },
      overlap: analysis.overlap,
      gap: analysis.gap,
      difficulty: analysis.difficulty
    });
  }

  return result;
}

function analyzeSpace(partyA, partyB, aspect) {
  const aBottom = partyA.bottom_line;
  const aIdeal = partyA.ideal;
  const bBottom = partyB.bottom_line;
  const bIdeal = partyB.ideal;

  const direction = DIRECTION_CONFIG[aspect] || DIRECTION_CONFIG.amount;
  let overlap = false;
  let gap = 0;

  if (direction.partyA === 'higher') {
    const aAcceptableMin = Math.min(aBottom, aIdeal);
    const aAcceptableMax = Math.max(aBottom, aIdeal);
    const bAcceptableMin = Math.min(bBottom, bIdeal);
    const bAcceptableMax = Math.max(bBottom, bIdeal);

    overlap = aAcceptableMin <= bAcceptableMax && bAcceptableMin <= aAcceptableMax;

    if (!overlap) {
      if (aAcceptableMax < bAcceptableMin) {
        gap = bAcceptableMin - aAcceptableMax;
      } else {
        gap = aAcceptableMin - bAcceptableMax;
      }
    }
  } else {
    const aAcceptableMin = Math.min(aBottom, aIdeal);
    const aAcceptableMax = Math.max(aBottom, aIdeal);
    const bAcceptableMin = Math.min(bBottom, bIdeal);
    const bAcceptableMax = Math.max(bBottom, bIdeal);

    overlap = aAcceptableMin <= bAcceptableMax && bAcceptableMin <= aAcceptableMax;

    if (!overlap) {
      if (aAcceptableMax < bAcceptableMin) {
        gap = bAcceptableMin - aAcceptableMax;
      } else {
        gap = aAcceptableMin - bAcceptableMax;
      }
    }
  }

  const totalWeight = partyA.weight + partyB.weight;
  const avgWeight = totalWeight / 2;
  let difficulty;

  if (overlap) {
    difficulty = 'easy';
  } else {
    const gapRatio = Math.abs(gap) / (Math.abs(aBottom) + Math.abs(bBottom)) * 2;
    if (gapRatio < 0.1 && avgWeight < 5) {
      difficulty = 'easy';
    } else if (gapRatio < 0.3 && avgWeight < 7) {
      difficulty = 'medium';
    } else if (gapRatio < 0.5) {
      difficulty = 'hard';
    } else {
      difficulty = 'deadlock';
    }
  }

  return { overlap, gap, difficulty };
}

function simulateNegotiation(contractId, maxRounds = 5, strategy = 'balanced') {
  const spaces = calculateNegotiationSpace(contractId);
  const coefficient = STRATEGY_COEFFICIENTS[strategy] || STRATEGY_COEFFICIENTS.balanced;

  const rounds = [];
  const settledClauses = new Set();
  const clauseStates = {};

  for (const space of spaces) {
    clauseStates[`${space.clause_id}_${space.aspect}`] = {
      clause_id: space.clause_id,
      aspect: space.aspect,
      party_a_current: space.party_a.ideal,
      party_b_current: space.party_b.ideal,
      party_a_bottom: space.party_a.bottom_line,
      party_b_bottom: space.party_b.bottom_line,
      party_a_weight: space.party_a.weight,
      party_b_weight: space.party_b.weight,
      settled: false,
      settled_round: null,
      agreed_value: null
    };
  }

  for (let round = 1; round <= maxRounds; round++) {
    const roundMoves = [];
    const roundSettled = [];

    for (const key in clauseStates) {
      const state = clauseStates[key];
      if (state.settled) continue;

      const direction = DIRECTION_CONFIG[state.aspect] || DIRECTION_CONFIG.amount;

      const aRange = Math.abs(state.party_a_bottom - state.party_a_current);
      const bRange = Math.abs(state.party_b_bottom - state.party_b_current);

      const aConcession = (aRange * coefficient) / round;
      const bConcession = (bRange * coefficient) / round;

      if (direction.partyA === 'higher') {
        if (state.party_a_bottom > state.party_a_current) {
          state.party_a_current = Math.min(state.party_a_current + aConcession, state.party_a_bottom);
        } else {
          state.party_a_current = Math.max(state.party_a_current - aConcession, state.party_a_bottom);
        }

        if (state.party_b_bottom > state.party_b_current) {
          state.party_b_current = Math.min(state.party_b_current + bConcession, state.party_b_bottom);
        } else {
          state.party_b_current = Math.max(state.party_b_current - bConcession, state.party_b_bottom);
        }
      } else {
        if (state.party_a_bottom > state.party_a_current) {
          state.party_a_current = Math.min(state.party_a_current + aConcession, state.party_a_bottom);
        } else {
          state.party_a_current = Math.max(state.party_a_current - aConcession, state.party_a_bottom);
        }

        if (state.party_b_bottom > state.party_b_current) {
          state.party_b_current = Math.min(state.party_b_current + bConcession, state.party_b_bottom);
        } else {
          state.party_b_current = Math.max(state.party_b_current - bConcession, state.party_b_bottom);
        }
      }

      roundMoves.push({
        clause_id: state.clause_id,
        party: '甲方',
        offered_value: Math.round(state.party_a_current * 100) / 100
      });
      roundMoves.push({
        clause_id: state.clause_id,
        party: '乙方',
        offered_value: Math.round(state.party_b_current * 100) / 100
      });

      const isSettled = checkSettlement(state, direction);
      if (isSettled) {
        state.settled = true;
        state.settled_round = round;
        state.agreed_value = (state.party_a_current + state.party_b_current) / 2;
        state.agreed_value = Math.round(state.agreed_value * 100) / 100;
        settledClauses.add(state.clause_id);
        roundSettled.push(`${state.clause_id}_${state.aspect}`);
      }
    }

    rounds.push({
      round_number: round,
      moves: roundMoves,
      settled: roundSettled
    });

    const allSettled = Object.values(clauseStates).every(s => s.settled);
    if (allSettled) break;
  }

  const finalResult = {
    settled_clauses: [],
    deadlocked_clauses: []
  };

  for (const key in clauseStates) {
    const state = clauseStates[key];
    
    runSql(
      `INSERT OR REPLACE INTO negotiation_results 
       (contract_id, clause_id, aspect, status, agreed_value, party_a_final, party_b_final, rounds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contractId,
        state.clause_id,
        state.aspect,
        state.settled ? 'settled' : 'deadlock',
        state.agreed_value,
        Math.round(state.party_a_current * 100) / 100,
        Math.round(state.party_b_current * 100) / 100,
        state.settled_round || maxRounds
      ]
    );

    if (state.settled) {
      finalResult.settled_clauses.push({
        clause_id: state.clause_id,
        aspect: state.aspect,
        agreed_value: state.agreed_value
      });
    } else {
      finalResult.deadlocked_clauses.push({
        clause_id: state.clause_id,
        aspect: state.aspect,
        party_a_final: Math.round(state.party_a_current * 100) / 100,
        party_b_final: Math.round(state.party_b_current * 100) / 100,
        gap: Math.round(Math.abs(state.party_a_current - state.party_b_current) * 100) / 100
      });
    }
  }

  return {
    rounds,
    final_result: finalResult
  };
}

function checkSettlement(state, direction) {
  const aCurrent = state.party_a_current;
  const bCurrent = state.party_b_current;
  const aBottom = state.party_a_bottom;
  const bBottom = state.party_b_bottom;

  const aAcceptableMin = Math.min(aBottom, state.party_a_current);
  const aAcceptableMax = Math.max(aBottom, state.party_a_current);
  const bAcceptableMin = Math.min(bBottom, state.party_b_current);
  const bAcceptableMax = Math.max(bBottom, state.party_b_current);

  return aCurrent <= bAcceptableMax && aCurrent >= bAcceptableMin &&
         bCurrent <= aAcceptableMax && bCurrent >= aAcceptableMin;
}

function generateReport(contractId) {
  const results = queryAll(
    'SELECT * FROM negotiation_results WHERE contract_id = ?',
    [contractId]
  );

  const positions = getPositions(contractId);

  if (results.length === 0) {
    return { error: '暂无谈判结果，请先运行模拟' };
  }

  const settled = results.filter(r => r.status === 'settled');
  const deadlocked = results.filter(r => r.status === 'deadlock');

  const totalClauses = new Set(results.map(r => r.clause_id)).size;
  const settledClausesSet = new Set(settled.map(r => r.clause_id));
  const settledCount = settledClausesSet.size;
  const deadlockCount = totalClauses - settledCount;

  const avgRounds = settled.length > 0 
    ? settled.reduce((sum, r) => sum + r.rounds, 0) / settled.length 
    : 0;

  let hardestClause = null;
  if (deadlocked.length > 0) {
    let maxWeight = -1;
    for (const dl of deadlocked) {
      const aPos = positions.party_a.find(p => p.clause_id === dl.clause_id && p.aspect === dl.aspect);
      const bPos = positions.party_b.find(p => p.clause_id === dl.clause_id && p.aspect === dl.aspect);
      const totalWeight = (aPos?.weight || 0) + (bPos?.weight || 0);
      if (totalWeight > maxWeight) {
        maxWeight = totalWeight;
        hardestClause = {
          clause_id: dl.clause_id,
          aspect: dl.aspect,
          total_weight: totalWeight,
          gap: Math.abs(dl.party_a_final - dl.party_b_final)
        };
      }
    }
  }

  let aTotalRange = 0;
  let aTotalConcession = 0;
  let bTotalRange = 0;
  let bTotalConcession = 0;

  for (const pos of positions.party_a) {
    const result = results.find(r => r.clause_id === pos.clause_id && r.aspect === pos.aspect);
    if (result) {
      const range = Math.abs(pos.ideal - pos.bottom_line);
      const concession = Math.abs(pos.ideal - result.party_a_final);
      aTotalRange += range;
      aTotalConcession += concession;
    }
  }

  for (const pos of positions.party_b) {
    const result = results.find(r => r.clause_id === pos.clause_id && r.aspect === pos.aspect);
    if (result) {
      const range = Math.abs(pos.ideal - pos.bottom_line);
      const concession = Math.abs(pos.ideal - result.party_b_final);
      bTotalRange += range;
      bTotalConcession += concession;
    }
  }

  const partyAConcessionPct = aTotalRange > 0 ? Math.round((aTotalConcession / aTotalRange) * 100) : 0;
  const partyBConcessionPct = bTotalRange > 0 ? Math.round((bTotalConcession / bTotalRange) * 100) : 0;

  return {
    total_clauses_negotiated: totalClauses,
    settled_count: settledCount,
    deadlock_count: deadlockCount,
    settlement_rate: totalClauses > 0 ? Math.round((settledCount / totalClauses) * 100) : 0,
    avg_rounds_to_settle: Math.round(avgRounds * 10) / 10,
    hardest_clause: hardestClause,
    concession_summary: {
      party_a_total_concession_pct: partyAConcessionPct,
      party_b_total_concession_pct: partyBConcessionPct
    }
  };
}

function seedNegotiationPositions(contractId) {
  const existing = queryOne(
    'SELECT COUNT(*) as cnt FROM negotiation_positions WHERE contract_id = ?',
    [contractId]
  );

  if (existing && existing.cnt > 0) {
    return;
  }

  const positions = [
    { party: '甲方', clause_id: 'C05', aspect: 'amount', bottom_line: 10, ideal: 50, weight: 9 },
    { party: '乙方', clause_id: 'C05', aspect: 'amount', bottom_line: 100, ideal: 20, weight: 8 },
    { party: '甲方', clause_id: 'C07', aspect: 'duration', bottom_line: 30, ideal: 120, weight: 7 },
    { party: '乙方', clause_id: 'C07', aspect: 'duration', bottom_line: 180, ideal: 30, weight: 6 },
    { party: '甲方', clause_id: 'C09', aspect: 'duration', bottom_line: 30, ideal: 365, weight: 5 },
    { party: '乙方', clause_id: 'C09', aspect: 'duration', bottom_line: 730, ideal: 90, weight: 4 },
    { party: '甲方', clause_id: 'C11', aspect: 'duration', bottom_line: 7, ideal: 60, weight: 6 },
    { party: '乙方', clause_id: 'C11', aspect: 'duration', bottom_line: 90, ideal: 15, weight: 7 }
  ];

  for (const pos of positions) {
    runSql(
      `INSERT INTO negotiation_positions 
       (contract_id, party, clause_id, aspect, bottom_line, ideal, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [contractId, pos.party, pos.clause_id, pos.aspect, pos.bottom_line, pos.ideal, pos.weight]
    );
  }
}

module.exports = {
  savePositions,
  getPositions,
  calculateNegotiationSpace,
  simulateNegotiation,
  generateReport,
  seedNegotiationPositions
};
