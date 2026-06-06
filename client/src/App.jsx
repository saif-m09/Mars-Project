import React, { useEffect, useState, useRef } from 'react';
import { 
  Share2, 
  Download, 
  UploadCloud, 
  CheckCircle, 
  AlertCircle, 
  Terminal, 
  Copy, 
  Check, 
  Loader2, 
  Wifi, 
  Pause, 
  Play, 
  FileText, 
  RefreshCw 
} from 'lucide-react';
import { useWebRTC } from './hooks/useWebRTC';

function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (seconds === Infinity || isNaN(seconds) || seconds === 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const {
    isSender,
    roomId,
    connectionStatus,
    fileInfo,
    progress,
    speed,
    eta,
    logs,
    transferState,
    peersCount,
    error,
    startFileShare,
    startFileReceive,
    pauseTransfer,
    resumeTransfer
  } = useWebRTC();

  const [copied, setCopied] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  // Parse hash on mount to see if we are in "receive" mode
  useEffect(() => {
    const parseHash = () => {
      const hash = window.location.hash.substring(1);
      if (!hash) return;

      const params = new URLSearchParams(hash);
      const hashRoomId = params.get('room');
      const hashKeyHex = params.get('key');

      if (hashRoomId && hashKeyHex) {
        startFileReceive(hashRoomId, hashKeyHex);
      }
    };

    parseHash();
    // Watch hash change if user updates link manually
    window.addEventListener('hashchange', parseHash);
    return () => window.removeEventListener('hashchange', parseHash);
  }, []);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      startFileShare(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      startFileShare(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current.click();
  };

  const getInviteUrl = () => {
    if (!roomId) return '';
    const keyHex = window.location.hash.split('key=')[1];
    const origin = window.location.origin + window.location.pathname;
    return `${origin}#room=${roomId}&key=${keyHex}`;
  };

  const handleCopyLink = () => {
    const url = getInviteUrl();
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    window.location.hash = '';
    window.location.reload();
  };

  // Status message based on connection status
  const getConnectionStatusText = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'Direct P2P Link Established';
      case 'connecting':
        return 'Connecting to Signaling Server...';
      case 'reconnecting':
        return 'Attempting Peer Reconnection...';
      case 'failed':
        return 'Connection Failed / Standby';
      default:
        return 'Disconnected';
    }
  };

  return (
    <div className="app-container">
      <header>
        <div className="logo">
          <Share2 size={24} />
          <span>MARS P2P Web Share</span>
        </div>
        
        <div className="connection-pill">
          <span className={`status-dot ${connectionStatus}`} />
          <span>{getConnectionStatusText()}</span>
          {peersCount > 0 && (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
              ({peersCount} Peer)
            </span>
          )}
        </div>
      </header>

      <main>
        {/* Left Side: Drag/Drop and Transfer Progress Dashboard */}
        <section className="sharing-column" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {transferState === 'idle' && !fileInfo && (
            <div className="panel">
              <h2 className="panel-title">
                <UploadCloud size={20} />
                <span>Share a File</span>
              </h2>
              
              <div 
                className={`dropzone ${dragActive ? 'drag-active' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={triggerFileInput}
              >
                <div className="dropzone-icon">
                  <UploadCloud size={32} />
                </div>
                <p className="dropzone-title">Drag and drop your file here</p>
                <p className="dropzone-desc">or click to browse from your device</p>
                <p className="dropzone-desc" style={{ fontSize: '0.75rem', color: 'var(--primary-hover)', marginTop: '0.5rem' }}>
                  ⚡ Encrypted browser-to-browser direct transfer (&lt; 50MB recommended)
                </p>
                <input 
                  type="file" 
                  className="dropzone-input" 
                  ref={fileInputRef}
                  onChange={handleFileChange}
                />
              </div>
            </div>
          )}

          {/* Cryptographic hash calculation phase */}
          {transferState === 'hashing' && (
            <div className="panel text-center" style={{ padding: '4rem 2rem' }}>
              <Loader2 className="pulsing-icon" size={48} style={{ animation: 'spin 2s linear infinite', margin: '0 auto 1.5rem auto' }} />
              <h3 style={{ marginBottom: '0.5rem' }}>Securing Your Transfer</h3>
              <p className="dropzone-desc">Generating AES encryption keys and computing SHA-256 integrity hash...</p>
            </div>
          )}

          {/* Transfer Dashboard */}
          {fileInfo && transferState !== 'hashing' && (
            <div className="panel sharing-dashboard">
              <div>
                <h2 className="panel-title">
                  {isSender ? <UploadCloud size={20} /> : <Download size={20} />}
                  <span>{isSender ? 'Sending File' : 'Receiving File'}</span>
                </h2>
                
                <div className="file-card">
                  <div className="file-icon">
                    <FileText size={24} />
                  </div>
                  <div className="file-details">
                    <div className="file-name" title={fileInfo.name}>{fileInfo.name}</div>
                    <div className="file-size">{formatBytes(fileInfo.size)}</div>
                  </div>
                </div>
              </div>

              {/* Progress and speed metrics */}
              {transferState !== 'completed' && transferState !== 'failed' && (
                <div className="progress-container">
                  <div className="progress-header">
                    <span>
                      {transferState === 'transferring' ? 'Streaming data packets...' : 'Ready for transfer'}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{progress}%</span>
                  </div>
                  
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${progress}%` }} />
                  </div>

                  <div className="stats-grid">
                    <div className="stat-item">
                      <span className="stat-label">Speed</span>
                      <span className="stat-value">{speed} MB/s</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">Progress</span>
                      <span className="stat-value">{formatBytes(progress * fileInfo.size / 100)}</span>
                    </div>
                    <div className="stat-item">
                      <span className="stat-label">ETA</span>
                      <span className="stat-value">{formatTime(eta)}</span>
                    </div>
                  </div>

                  {/* Transfer pause/resume controls */}
                  {connectionStatus === 'connected' && (
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                      {transferState === 'transferring' ? (
                        <button className="btn btn-secondary" onClick={pauseTransfer} style={{ flex: 1 }}>
                          <Pause size={16} /> Pause
                        </button>
                      ) : (
                        <button className="btn btn-primary" onClick={resumeTransfer} style={{ flex: 1 }}>
                          <Play size={16} /> Resume
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Completed Success View */}
              {transferState === 'completed' && (
                <div className="completed-state">
                  <div className="completed-icon">
                    <CheckCircle size={36} />
                  </div>
                  <h3>Transfer Complete!</h3>
                  <p className="dropzone-desc" style={{ maxWidth: '400px' }}>
                    The file was successfully transferred directly via WebRTC, decrypted, and verified against the source SHA-256 hash.
                  </p>
                  
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', width: '100%' }}>
                    <button className="btn btn-primary" onClick={handleReset} style={{ flex: 1 }}>
                      <RefreshCw size={16} /> Share Another File
                    </button>
                  </div>
                </div>
              )}

              {/* Failed Error View */}
              {(transferState === 'failed' || error) && (
                <div className="completed-state" style={{ borderColor: 'var(--danger)' }}>
                  <div className="completed-icon" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--danger)', boxShadow: 'none' }}>
                    <AlertCircle size={36} />
                  </div>
                  <h3>Transfer Failed</h3>
                  <p className="dropzone-desc" style={{ color: 'var(--danger)', maxWidth: '400px' }}>
                    {error || 'The connection was interrupted.'}
                  </p>
                  <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', width: '100%' }}>
                    <button className="btn btn-primary" onClick={handleReset} style={{ flex: 1 }}>
                      Try Again
                    </button>
                  </div>
                </div>
              )}

              {/* Share URL (only visible to Sender) */}
              {isSender && transferState !== 'completed' && transferState !== 'failed' && (
                <div className="share-url-container">
                  <span className="share-url-label">Share this Room URL with the receiver:</span>
                  <div className="share-url-box">
                    <input 
                      type="text" 
                      className="share-url-input" 
                      readOnly 
                      value={getInviteUrl()} 
                      onClick={(e) => e.target.select()}
                    />
                    <button className="btn btn-primary" onClick={handleCopyLink} style={{ minWidth: '120px' }}>
                      {copied ? (
                        <>
                          <Check size={16} /> Copied
                        </>
                      ) : (
                        <>
                          <Copy size={16} /> Copy Link
                        </>
                      )}
                    </button>
                  </div>

                  {/* QR Code */}
                  <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                    <p className="share-url-label" style={{ marginBottom: '0.75rem' }}>Or scan QR Code to connect:</p>
                    <div className="qr-container">
                      <img 
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(getInviteUrl())}`}
                        alt="Scan Room QR"
                        style={{ width: '100%', height: '100%' }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Waiting State for Receiver */}
              {!isSender && transferState === 'idle' && (
                <div className="text-center" style={{ padding: '2rem 1rem' }}>
                  <Loader2 className="pulsing-icon" size={36} style={{ animation: 'spin 2s linear infinite', margin: '0 auto 1rem auto' }} />
                  <p className="dropzone-title">Connecting to Sender</p>
                  <p className="dropzone-desc">Establishing a secure direct WebRTC data stream. The transfer will begin automatically.</p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Right Side: Hacker-style Log Console */}
        <section className="panel log-panel">
          <h2 className="panel-title">
            <Terminal size={20} />
            <span>Connection & Security Logs</span>
          </h2>
          <div className="log-viewer">
            {logs.length === 0 ? (
              <div className="log-line" style={{ color: 'var(--text-muted)' }}>
                System idle. Awaiting actions...
              </div>
            ) : (
              logs.map((log, index) => {
                let colorClass = 'system';
                if (log.includes('🔒')) colorClass = 'crypto';
                else if (log.includes('📡')) colorClass = 'signal';
                else if (log.includes('⚡')) colorClass = 'webrtc';
                else if (log.includes('📦')) colorClass = 'transfer';
                else if (log.includes('✅')) colorClass = 'success';
                else if (log.includes('❌') || log.includes('⚠️')) colorClass = 'error';

                return (
                  <div key={index} className={`log-line ${colorClass}`} style={{
                    color: 
                      colorClass === 'crypto' ? 'var(--primary-hover)' :
                      colorClass === 'signal' ? '#60a5fa' :
                      colorClass === 'webrtc' ? '#f472b6' :
                      colorClass === 'transfer' ? '#38bdf8' :
                      colorClass === 'success' ? 'var(--success)' :
                      colorClass === 'error' ? 'var(--danger)' : 'var(--text-secondary)'
                  }}>
                    {log}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>

      <footer>
        <p>MARS Open Projects 2026 • Direct Browser-to-Browser Secure File sharing</p>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
          Zero-Knowledge AES-GCM Encrypted. File data never touches the signaling server.
        </p>
      </footer>
    </div>
  );
}
