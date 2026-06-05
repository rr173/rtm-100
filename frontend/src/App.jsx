import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchContracts, fetchContract, fetchConflicts, fetchRisks, fetchReviewStatus,
  fetchRevisions, uploadRevision, fetchDiff, fetchDeps, analyzeDeps
} from './api';
import ContractOverview from './components/ContractOverview';
import ContractTree from './components/ContractTree';
import ClauseDetail from './components/ClauseDetail';
import RevisionDiffView from './components/RevisionDiffView';
import UploadRevisionModal from './components/UploadRevisionModal';
import DependencyGraph from './components/DependencyGraph';

export default function App() {
  const [contracts, setContracts] = useState([]);
  const [selectedContractId, setSelectedContractId] = useState(null);
  const [contract, setContract] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [risks, setRisks] = useState([]);
  const [reviewStatus, setReviewStatus] = useState(null);
  const [selectedClauseId, setSelectedClauseId] = useState(null);
  const [loading, setLoading] = useState(false);

  const [viewMode, setViewMode] = useState('review');
  const [revisions, setRevisions] = useState([]);
  const [fromRevision, setFromRevision] = useState(1);
  const [toRevision, setToRevision] = useState(2);
  const [diffData, setDiffData] = useState(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [depsData, setDepsData] = useState(null);
  const [depsLoading, setDepsLoading] = useState(false);

  useEffect(() => {
    fetchContracts().then(data => {
      setContracts(data);
      if (data.length > 0 && !selectedContractId) {
        setSelectedContractId(data[0].id);
      }
    });
  }, []);

  const loadContractData = useCallback(async (id) => {
    setLoading(true);
    try {
      const [contractData, conflictsData, risksData, statusData, revisionsData] = await Promise.all([
        fetchContract(id),
        fetchConflicts(id),
        fetchRisks(id),
        fetchReviewStatus(id),
        fetchRevisions(id)
      ]);
      setContract(contractData);
      setConflicts(conflictsData);
      setRisks(risksData);
      setReviewStatus(statusData);
      setRevisions(revisionsData);
      
      if (revisionsData.length >= 2) {
        setFromRevision(revisionsData[0].revision_number);
        setToRevision(revisionsData[revisionsData.length - 1].revision_number);
      }

      if (contractData.clauses && contractData.clauses.length > 0 && !selectedClauseId) {
        setSelectedClauseId(contractData.clauses[0].clause_id);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedClauseId]);

  useEffect(() => {
    if (selectedContractId) {
      loadContractData(selectedContractId);
    }
  }, [selectedContractId]);

  useEffect(() => {
    if (selectedContractId && viewMode === 'diff' && revisions.length >= 2 && fromRevision < toRevision) {
      fetchDiff(selectedContractId, fromRevision, toRevision).then(data => {
        setDiffData(data);
      });
    }
  }, [selectedContractId, viewMode, fromRevision, toRevision, revisions.length]);

  const loadDepsData = useCallback(async (contractId, revision = 1) => {
    setDepsLoading(true);
    try {
      await analyzeDeps(contractId, revision);
      const data = await fetchDeps(contractId, revision);
      setDepsData(data);
    } finally {
      setDepsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedContractId && viewMode === 'graph') {
      loadDepsData(selectedContractId, 1);
    }
  }, [selectedContractId, viewMode, loadDepsData]);

  const handleClauseSelect = (clauseId) => {
    setSelectedClauseId(clauseId);
  };

  const handleConflictResolved = () => {
    if (selectedContractId) {
      loadContractData(selectedContractId);
    }
  };

  const handleUploadRevision = async (clauses) => {
    if (!selectedContractId) return;
    await uploadRevision(selectedContractId, clauses);
    await loadContractData(selectedContractId);
  };

  const selectedClause = contract?.clauses?.find(c => c.clause_id === selectedClauseId);

  const clauseConflicts = conflicts.filter(
    c => c.clause_a_id === selectedClauseId || c.clause_b_id === selectedClauseId
  );

  const clauseRisks = risks.filter(r => r.clause_id === selectedClauseId);

  const getConflictCountForClause = (clauseId) => {
    return conflicts.filter(c => c.clause_a_id === clauseId || c.clause_b_id === clauseId).length;
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>合同条款冲突检测与风险标注</h1>
        <div className="contract-selector">
          <label>选择合同: </label>
          <select
            value={selectedContractId || ''}
            onChange={e => setSelectedContractId(parseInt(e.target.value))}
          >
            {contracts.map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>
        <div className="view-toggle">
          <div className="view-buttons">
            <button
              className={`view-btn ${viewMode === 'review' ? 'active' : ''}`}
              onClick={() => setViewMode('review')}
            >
              审阅模式
            </button>
            <button
              className={`view-btn ${viewMode === 'diff' ? 'active' : ''}`}
              onClick={() => setViewMode('diff')}
              disabled={revisions.length < 2}
            >
              修订对比
            </button>
            <button
              className={`view-btn ${viewMode === 'graph' ? 'active' : ''}`}
              onClick={() => setViewMode('graph')}
            >
              依赖图谱
            </button>
          </div>
          {viewMode === 'diff' && revisions.length >= 2 && (
            <div className="version-selectors">
              <div className="version-selector">
                <label>从:</label>
                <select
                  value={fromRevision}
                  onChange={e => setFromRevision(parseInt(e.target.value))}
                >
                  {revisions.map(r => (
                    <option key={r.revision_number} value={r.revision_number}
                      disabled={r.revision_number >= toRevision}>
                      版本 {r.revision_number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="version-selector">
                <label>到:</label>
                <select
                  value={toRevision}
                  onChange={e => setToRevision(parseInt(e.target.value))}
                >
                  {revisions.map(r => (
                    <option key={r.revision_number} value={r.revision_number}
                      disabled={r.revision_number <= fromRevision}>
                      版本 {r.revision_number}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <button
            className="upload-revision-btn"
            onClick={() => setShowUploadModal(true)}
          >
            上传修订版
          </button>
        </div>
      </header>

      {viewMode === 'review' && contract && reviewStatus && (
        <ContractOverview
          contract={contract}
          reviewStatus={reviewStatus}
          risks={risks}
          conflicts={conflicts}
        />
      )}

      {viewMode === 'review' && (
        <div className="app-body">
          <div className="left-panel">
            {contract && (
              <ContractTree
                clauses={contract.clauses}
                selectedClauseId={selectedClauseId}
                onSelectClause={handleClauseSelect}
                getConflictCountForClause={getConflictCountForClause}
              />
            )}
          </div>
          <div className="right-panel">
            {loading && <div className="loading">加载中...</div>}
            {!loading && selectedClause && (
              <ClauseDetail
                clause={selectedClause}
                conflicts={clauseConflicts}
                risks={clauseRisks}
                allClauses={contract?.clauses || []}
                contractId={selectedContractId}
                onConflictResolved={handleConflictResolved}
              />
            )}
          </div>
        </div>
      )}

      {viewMode === 'diff' && (
        <RevisionDiffView diffData={diffData} />
      )}

      {viewMode === 'graph' && (
        <div className="graph-view">
          {depsLoading && <div className="loading">加载依赖图谱中...</div>}
          {!depsLoading && (
            <DependencyGraph
              depsData={depsData}
              onNodeClick={handleClauseSelect}
            />
          )}
        </div>
      )}

      <UploadRevisionModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onUpload={handleUploadRevision}
        currentClauses={contract?.clauses}
      />
    </div>
  );
}
