import React, { useState } from 'react';

export default function UploadRevisionModal({ isOpen, onClose, onUpload, currentClauses }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  if (!isOpen) return null;

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      setFile(droppedFile);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      let clauses = data.clauses || data;
      if (!Array.isArray(clauses)) {
        throw new Error('文件格式不正确，需要包含clauses数组');
      }

      clauses = clauses.map(c => ({
        id: c.id || c.clause_id,
        clause_id: c.id || c.clause_id,
        section: c.section,
        title: c.title,
        body: c.body,
        tags: c.tags || []
      }));

      await onUpload(clauses);
      setFile(null);
      onClose();
    } catch (err) {
      alert('文件解析失败: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="upload-modal" onClick={onClose}>
      <div className="upload-modal-content" onClick={e => e.stopPropagation()}>
        <div className="upload-modal-header">
          <h3>上传修订版合同</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div
          className={`upload-area ${dragOver ? 'dragover' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <input
            id="file-input"
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <div className="upload-icon">📄</div>
          <div className="upload-text">
            {file ? file.name : '点击或拖拽上传JSON文件'}
          </div>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '8px' }}>
            文件需要包含与原版相同结构的clauses数组
          </div>
        </div>

        {currentClauses && (
          <div style={{ marginBottom: '20px', padding: '12px', background: '#f8fafc', borderRadius: '6px' }}>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '4px' }}>
              当前版本条款数: {currentClauses.length}
            </div>
          </div>
        )}

        <button
          className="btn-primary"
          onClick={handleUpload}
          disabled={!file || uploading}
        >
          {uploading ? '上传中...' : '上传并开始对比'}
        </button>
      </div>
    </div>
  );
}
