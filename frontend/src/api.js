const API_BASE = '/api';

export async function fetchContracts() {
  const res = await fetch(`${API_BASE}/contracts`);
  return res.json();
}

export async function fetchContract(id) {
  const res = await fetch(`${API_BASE}/contracts/${id}`);
  return res.json();
}

export async function uploadContract(contract) {
  const res = await fetch(`${API_BASE}/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(contract)
  });
  return res.json();
}

export async function fetchConflicts(contractId) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/conflicts`);
  return res.json();
}

export async function fetchRisks(contractId) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/risks`);
  return res.json();
}

export async function resolveConflict(contractId, conflictId, data) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/conflicts/${conflictId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

export async function fetchReviewStatus(contractId) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/review-status`);
  return res.json();
}

export async function fetchConflictRules() {
  const res = await fetch(`${API_BASE}/rules/conflicts`);
  return res.json();
}

export async function fetchRiskRules() {
  const res = await fetch(`${API_BASE}/rules/risks`);
  return res.json();
}

export async function createConflictRule(rule) {
  const res = await fetch(`${API_BASE}/rules/conflicts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule)
  });
  return res.json();
}

export async function createRiskRule(rule) {
  const res = await fetch(`${API_BASE}/rules/risks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule)
  });
  return res.json();
}

export async function fetchRevisions(contractId) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/revisions`);
  return res.json();
}

export async function uploadRevision(contractId, clauses) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clauses })
  });
  return res.json();
}

export async function fetchRevision(contractId, revision) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/revisions/${revision}`);
  return res.json();
}

export async function fetchDiff(contractId, fromRev, toRev) {
  const res = await fetch(`${API_BASE}/contracts/${contractId}/diff?from=${fromRev}&to=${toRev}`);
  return res.json();
}
