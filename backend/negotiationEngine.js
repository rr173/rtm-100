const { queryAll, queryOne, runSql } = require('./database');

const STRATEGY_COEFFICIENTS = {
  balanced: 0.3,
  aggressive: 0.15,
  conservative: 0.5
};

const PREFERENCE_DIRECTION = {
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

function getAcceptableRange(bottomLine, ideal, preference) {
  if (preference === 'higher') {
    return { min: bottomLine, max: Infinity };
  } else {
    return { min: -Infinity, max: bottomLine };
  }
}

function calculateNegotiationSpace(contractId, weightAdjustments) {
  const positions = getPositions(contractId);
  const result = [];

  const clauseAspectMap = {};
  for (const pos of positions.party_a) {
    const key = `${pos.clause_id}_${pos.aspect}`;
    if (!clauseAspectMap[key]) {
      clauseAspectMap[key] = { clause_id: pos.clause_id, aspect: pos.aspect };
    }
    const adjustedWeight = weightAdjustments && weightAdjustments[pos.clause_id]
      ? pos.weight * weightAdjustments[pos.clause_id]
      : pos.weight;
    clauseAspectMap[key].party_a = { ...pos, weight: adjustedWeight };
  }
  for (const pos of positions.party_b) {
    const key = `${pos.clause_id}_${pos.aspect}`;
    if (!clauseAspectMap[key]) {
      clauseAspectMap[key] = { clause_id: pos.clause_id, aspect: pos.aspect };
    }
    const adjustedWeight = weightAdjustments && weightAdjustments[pos.clause_id]
      ? pos.weight * weightAdjustments[pos.clause_id]
      : pos.weight;
    clauseAspectMap[key].party_b = { ...pos, weight: adjustedWeight };
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
  const direction = PREFERENCE_DIRECTION[aspect] || PREFERENCE_DIRECTION.amount;

  const aRange = getAcceptableRange(partyA.bottom_line, partyA.ideal, direction.partyA);
  const bRange = getAcceptableRange(partyB.bottom_line, partyB.ideal, direction.partyB);

  const overlapMin = Math.max(aRange.min, bRange.min);
  const overlapMax = Math.min(aRange.max, bRange.max);
  const overlap = overlapMin <= overlapMax;

  let gap = 0;
  if (!overlap) {
    gap = Math.abs(overlapMax - overlapMin);
  }

  const totalWeight = partyA.weight + partyB.weight;
  const avgWeight = totalWeight / 2;
  let difficulty;

  if (overlap) {
    const overlapSize = Math.min(
      overlapMax === Infinity ? Math.abs(partyA.bottom_line - partyB.bottom_line) * 2 : overlapMax - overlapMin,
      1000000
    );
    const totalRange = Math.abs(partyA.bottom_line) + Math.abs(partyB.bottom_line) + 1;
    const overlapRatio = overlapSize / totalRange;

    if (overlapRatio > 0.3 && avgWeight < 6) {
      difficulty = 'easy';
    } else if (overlapRatio > 0.1) {
      difficulty = 'medium';
    } else {
      difficulty = 'hard';
    }
  } else {
    const gapRatio = gap / (Math.abs(partyA.bottom_line) + Math.abs(partyB.bottom_line) + 1);
    if (gapRatio < 0.1 && avgWeight < 5) {
      difficulty = 'easy';
    } else if (gapRatio < 0.3 && avgWeight < 7) {
      difficulty = 'medium';
    } else if (gapRatio < 0.6) {
      difficulty = 'hard';
    } else {
      difficulty = 'deadlock';
    }
  }

  return { overlap, gap, difficulty };
}

function moveTowardsBottom(current, bottomLine, preference, concession) {
  if (preference === 'higher') {
    return Math.max(current - concession, bottomLine);
  } else {
    return Math.min(current + concession, bottomLine);
  }
}

function simulateNegotiation(contractId, maxRounds = 5, strategy = 'balanced') {
  const sim = runSimulationInMemory(contractId, maxRounds, strategy);
  const { clauseStates } = sim;

  for (const key in clauseStates) {
    const state = clauseStates[key];

    runSql(
      'DELETE FROM negotiation_results WHERE contract_id = ? AND clause_id = ? AND aspect = ?',
      [contractId, state.clause_id, state.aspect]
    );
    runSql(
      `INSERT INTO negotiation_results 
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
  }

  return {
    rounds: sim.rounds,
    final_result: sim.final_result
  };
}

function checkSettlement(state, direction) {
  const aCurrent = state.party_a_current;
  const bCurrent = state.party_b_current;

  const aAcceptable = getAcceptableRange(state.party_a_bottom, state.party_a_ideal, direction.partyA);
  const bAcceptable = getAcceptableRange(state.party_b_bottom, state.party_b_ideal, direction.partyB);

  const aInBRange = aCurrent >= bAcceptable.min && aCurrent <= bAcceptable.max;
  const bInARange = bCurrent >= aAcceptable.min && bCurrent <= aAcceptable.max;

  return aInBRange && bInARange;
}

function runSimulationInMemory(contractId, maxRounds = 5, strategy = 'balanced', weightAdjustments) {
  const spaces = calculateNegotiationSpace(contractId, weightAdjustments);
  const coefficient = STRATEGY_COEFFICIENTS[strategy] || STRATEGY_COEFFICIENTS.balanced;

  const rounds = [];
  const clauseStates = {};

  for (const space of spaces) {
    clauseStates[`${space.clause_id}_${space.aspect}`] = {
      clause_id: space.clause_id,
      aspect: space.aspect,
      party_a_current: space.party_a.ideal,
      party_b_current: space.party_b.ideal,
      party_a_bottom: space.party_a.bottom_line,
      party_b_bottom: space.party_b.bottom_line,
      party_a_ideal: space.party_a.ideal,
      party_b_ideal: space.party_b.ideal,
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

      const direction = PREFERENCE_DIRECTION[state.aspect] || PREFERENCE_DIRECTION.amount;

      const aTotalRange = Math.abs(state.party_a_ideal - state.party_a_bottom);
      const bTotalRange = Math.abs(state.party_b_ideal - state.party_b_bottom);

      const aConcession = (aTotalRange * coefficient) / round;
      const bConcession = (bTotalRange * coefficient) / round;

      state.party_a_current = moveTowardsBottom(
        state.party_a_current,
        state.party_a_bottom,
        direction.partyA,
        aConcession
      );

      state.party_b_current = moveTowardsBottom(
        state.party_b_current,
        state.party_b_bottom,
        direction.partyB,
        bConcession
      );

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
    final_result: finalResult,
    clauseStates
  };
}

function calculateSatisfaction(clauseStates, positions, weightAdjustments) {
  let partyAScore = 0;
  let partyBScore = 0;
  let partyATotalWeight = 0;
  let partyBTotalWeight = 0;

  const posMapA = {};
  for (const pos of positions.party_a) {
    posMapA[`${pos.clause_id}_${pos.aspect}`] = pos;
    const multiplier = weightAdjustments && weightAdjustments[pos.clause_id] ? weightAdjustments[pos.clause_id] : 1;
    partyATotalWeight += pos.weight * multiplier;
  }
  const posMapB = {};
  for (const pos of positions.party_b) {
    posMapB[`${pos.clause_id}_${pos.aspect}`] = pos;
    const multiplier = weightAdjustments && weightAdjustments[pos.clause_id] ? weightAdjustments[pos.clause_id] : 1;
    partyBTotalWeight += pos.weight * multiplier;
  }

  for (const key in clauseStates) {
    const state = clauseStates[key];
    const posA = posMapA[key];
    const posB = posMapB[key];

    const multiplierA = weightAdjustments && weightAdjustments[state.clause_id] ? weightAdjustments[state.clause_id] : 1;
    const multiplierB = weightAdjustments && weightAdjustments[state.clause_id] ? weightAdjustments[state.clause_id] : 1;

    if (state.settled && posA) {
      const denom = Math.abs(posA.bottom_line - posA.ideal);
      if (denom > 0 && partyATotalWeight > 0) {
        const distance = Math.abs(state.agreed_value - posA.ideal);
        partyAScore += 100 * (1 - distance / denom) * (posA.weight * multiplierA) / partyATotalWeight;
      }
    }
    if (state.settled && posB) {
      const denom = Math.abs(posB.bottom_line - posB.ideal);
      if (denom > 0 && partyBTotalWeight > 0) {
        const distance = Math.abs(state.agreed_value - posB.ideal);
        partyBScore += 100 * (1 - distance / denom) * (posB.weight * multiplierB) / partyBTotalWeight;
      }
    }
  }

  return {
    party_a_satisfaction: Math.round(partyAScore * 10) / 10,
    party_b_satisfaction: Math.round(partyBScore * 10) / 10
  };
}

function calculateTotalConcession(clauseStates) {
  let totalConcession = 0;
  for (const key in clauseStates) {
    const state = clauseStates[key];
    const aConcession = Math.abs(state.party_a_ideal - state.party_a_current);
    const bConcession = Math.abs(state.party_b_ideal - state.party_b_current);
    totalConcession += aConcession + bConcession;
  }
  return Math.round(totalConcession * 100) / 100;
}

function findParetoFrontier(solutions) {
  const frontier = [];
  for (let i = 0; i < solutions.length; i++) {
    let dominated = false;
    for (let j = 0; j < solutions.length; j++) {
      if (i === j) continue;
      const a = solutions[i];
      const b = solutions[j];
      const bBetterOrEqualRate = b.settlement_rate >= a.settlement_rate;
      const bBetterOrEqualA = b.party_a_satisfaction >= a.party_a_satisfaction;
      const bBetterOrEqualB = b.party_b_satisfaction >= a.party_b_satisfaction;
      const bStrictlyBetter =
        b.settlement_rate > a.settlement_rate ||
        b.party_a_satisfaction > a.party_a_satisfaction ||
        b.party_b_satisfaction > a.party_b_satisfaction;
      if (bBetterOrEqualRate && bBetterOrEqualA && bBetterOrEqualB && bStrictlyBetter) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      frontier.push(solutions[i]);
    }
  }
  return frontier;
}

function compareScenarios(contractId, scenarios) {
  const positions = getPositions(contractId);
  const results = [];

  for (const scenario of scenarios) {
    const sim = runSimulationInMemory(
      contractId,
      scenario.max_rounds || 5,
      scenario.strategy || 'balanced',
      scenario.weight_adjustments
    );

    const settledCount = sim.final_result.settled_clauses.length;
    const deadlockCount = sim.final_result.deadlocked_clauses.length;
    const total = settledCount + deadlockCount;
    const settlementRate = total > 0 ? Math.round((settledCount / total) * 1000) / 10 : 0;

    const satisfaction = calculateSatisfaction(sim.clauseStates, positions, scenario.weight_adjustments);
    const totalConcession = calculateTotalConcession(sim.clauseStates);

    results.push({
      name: scenario.name,
      settled_count: settledCount,
      deadlock_count: deadlockCount,
      settlement_rate: settlementRate,
      party_a_satisfaction: satisfaction.party_a_satisfaction,
      party_b_satisfaction: satisfaction.party_b_satisfaction,
      total_concession: totalConcession
    });
  }

  return { scenarios: results };
}

function recommendStrategy(contractId) {
  const strategies = ['balanced', 'aggressive', 'conservative'];
  const roundsList = [3, 5, 8];
  const positions = getPositions(contractId);
  const solutions = [];

  for (const strategy of strategies) {
    for (const maxRounds of roundsList) {
      const sim = runSimulationInMemory(contractId, maxRounds, strategy);
      const settledCount = sim.final_result.settled_clauses.length;
      const deadlockCount = sim.final_result.deadlocked_clauses.length;
      const total = settledCount + deadlockCount;
      const settlementRate = total > 0 ? Math.round((settledCount / total) * 1000) / 10 : 0;
      const satisfaction = calculateSatisfaction(sim.clauseStates, positions);

      solutions.push({
        strategy,
        max_rounds: maxRounds,
        settlement_rate: settlementRate,
        party_a_satisfaction: satisfaction.party_a_satisfaction,
        party_b_satisfaction: satisfaction.party_b_satisfaction
      });
    }
  }

  const paretoFront = findParetoFrontier(solutions);
  let recommended = null;
  let maxRate = -1;
  for (const sol of paretoFront) {
    if (sol.settlement_rate > maxRate) {
      maxRate = sol.settlement_rate;
      recommended = sol;
    }
  }

  return {
    pareto_front: paretoFront,
    recommended
  };
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

  const totalClauseAspects = results.length;
  const settledCount = settled.length;
  const deadlockCount = deadlocked.length;

  const uniqueClauses = new Set(results.map(r => r.clause_id));
  const settledClausesSet = new Set(settled.map(r => r.clause_id));
  const uniqueSettledCount = settledClausesSet.size;
  const uniqueDeadlockCount = uniqueClauses.size - uniqueSettledCount;

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
    total_clauses_negotiated: uniqueClauses.size,
    total_aspects_negotiated: totalClauseAspects,
    settled_count: uniqueSettledCount,
    settled_aspects_count: settledCount,
    deadlock_count: uniqueDeadlockCount,
    deadlock_aspects_count: deadlockCount,
    settlement_rate: totalClauseAspects > 0 ? Math.round((settledCount / totalClauseAspects) * 100) : 0,
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
    { party: '甲方', clause_id: 'C05', aspect: 'amount', bottom_line: 20, ideal: 100, weight: 9 },
    { party: '乙方', clause_id: 'C05', aspect: 'amount', bottom_line: 80, ideal: 10, weight: 8 },
    { party: '甲方', clause_id: 'C07', aspect: 'duration', bottom_line: 45, ideal: 120, weight: 7 },
    { party: '乙方', clause_id: 'C07', aspect: 'duration', bottom_line: 90, ideal: 15, weight: 6 },
    { party: '甲方', clause_id: 'C09', aspect: 'duration', bottom_line: 365, ideal: 1095, weight: 5 },
    { party: '乙方', clause_id: 'C09', aspect: 'duration', bottom_line: 730, ideal: 180, weight: 4 },
    { party: '甲方', clause_id: 'C11', aspect: 'duration', bottom_line: 30, ideal: 90, weight: 6 },
    { party: '乙方', clause_id: 'C11', aspect: 'duration', bottom_line: 60, ideal: 7, weight: 7 }
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
  seedNegotiationPositions,
  compareScenarios,
  recommendStrategy
};
