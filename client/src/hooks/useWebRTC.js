import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  generateKey,
  exportKeyToHex,
  importKeyFromHex,
  encryptChunk,
  decryptChunk,
  computeSHA256,
  bufferToHex,
  hexToBuffer
} from '../utils/crypto';
import {
  saveChunk,
  getAllChunks,
  clearChunks,
  getStoredChunkCount
} from '../utils/indexedDB';

const CHUNK_SIZE = 32768; // 32 KB
const BUFFER_HIGH_WATERMARK = 1024 * 1024; // 1 MB
const BUFFER_LOW_WATERMARK = 1024 * 16; // 16 KB

// WebRTC ICE Configuration (Public Google STUN servers)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

const SIGNALING_URL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:4000'
    : 'https://mars-project-backend-02.onrender.com';

export function useWebRTC() {
  const [isSender, setIsSender] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected, connecting, connected, reconnecting, failed
  const [fileInfo, setFileInfo] = useState(null); // { name, size, type, totalChunks, hash }
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(0);
  const [logs, setLogs] = useState([]);
  const [transferState, setTransferState] = useState('idle'); // idle, hashing, transferring, completed, paused, failed
  const [peersCount, setPeersCount] = useState(0);
  const [error, setError] = useState(null);

  // Refs to hold persistent connection state
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const keyRef = useRef(null);
  const fileRef = useRef(null);
  const logsRef = useRef([]);

  // Transfer stats tracking
  const bytesTransferredRef = useRef(0);
  const speedStartTimeRef = useRef(0);
  const speedLastBytesRef = useRef(0);
  const speedIntervalRef = useRef(null);

  // State-tracking for resume
  const lastAcknowledgedChunkRef = useRef(-1);
  const isTransferringRef = useRef(false);
  const isBufferFullRef = useRef(false);

  // Helper to append UI logs
  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      info: '⚙️ [System]',
      crypto: '🔒 [Crypto]',
      signal: '📡 [Signaling]',
      webrtc: '⚡ [WebRTC]',
      transfer: '📦 [Transfer]',
      success: '✅ [Success]',
      error: '❌ [Error]'
    }[type] || '[Log]';

    const logLine = `[${timestamp}] ${prefix} ${message}`;
    logsRef.current = [logLine, ...logsRef.current].slice(0, 100); // Keep last 100 logs
    setLogs([...logsRef.current]);
    console.log(logLine);
  }, []);

  // Initialize socket.io signaling connection
  const initSocket = useCallback(() => {
    if (socketRef.current) return;

    addLog('Connecting to signaling server...', 'signal');
    socketRef.current = io(SIGNALING_URL);

    socketRef.current.on('connect', () => {
      addLog(`Signaling connection established (ID: ${socketRef.current.id})`, 'signal');
    });

    socketRef.current.on('connect_error', () => {
      addLog('Failed to connect to signaling server. Operating in offline P2P standby.', 'error');
      setConnectionStatus('failed');
    });

    socketRef.current.on('disconnect', () => {
      addLog('Disconnected from signaling server.', 'signal');
    });

    socketRef.current.on('room-peers', (peers) => {
      setPeersCount(peers.length);
      addLog(`Discovered ${peers.length} active peer(s) in this room.`, 'signal');
      
      // If we are the sender and a receiver is already here, we trigger the handshake
      if (isSender && peers.length > 0) {
        addLog('Initiating WebRTC offer generation...', 'webrtc');
        initiateWebRTCConnection(peers[0]);
      }
    });

    socketRef.current.on('peer-joined', (peerId) => {
      setPeersCount(prev => prev + 1);
      addLog(`New peer joined the room (ID: ${peerId})`, 'signal');
      
      // If we are the sender, initiate WebRTC connection
      if (isSender) {
        addLog(`Initiating connection handshake with peer ${peerId}`, 'webrtc');
        initiateWebRTCConnection(peerId);
      }
    });

    socketRef.current.on('peer-left', (peerId) => {
      setPeersCount(prev => Math.max(0, prev - 1));
      addLog(`Peer left the room (ID: ${peerId})`, 'signal');
      
      if (connectionStatus === 'connected') {
        setConnectionStatus('reconnecting');
        addLog('Connection lost. Waiting for peer to reconnect to resume transfer...', 'webrtc');
        cleanupWebRTC();
      }
    });

    // Handle received signaling data
    socketRef.current.on('signal', async ({ senderId, signalData }) => {
      try {
        if (!peerConnectionRef.current) {
          createPeerConnection(senderId);
        }

        const pc = peerConnectionRef.current;

        if (signalData.sdp) {
          addLog(`Received SDP ${signalData.sdp.type} from peer.`, 'webrtc');
          await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));

          if (signalData.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            addLog('Generated local SDP answer. Sending back to peer...', 'webrtc');
            socketRef.current.emit('signal', {
              targetId: senderId,
              signalData: { sdp: answer }
            });
          }
        } else if (signalData.candidate) {
          addLog('Received remote ICE candidate.', 'webrtc');
          await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
      } catch (err) {
        addLog(`Error processing signaling data: ${err.message}`, 'error');
      }
    });
  }, [isSender, connectionStatus, addLog]);

  // Clean up WebRTC peer connections
  const cleanupWebRTC = () => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    isTransferringRef.current = false;
    stopSpeedTracker();
  };

  // Helper to start measuring speed
  const startSpeedTracker = () => {
    stopSpeedTracker();
    speedStartTimeRef.current = Date.now();
    speedLastBytesRef.current = bytesTransferredRef.current;
    
    speedIntervalRef.current = setInterval(() => {
      const timeElapsed = (Date.now() - speedStartTimeRef.current) / 1000;
      if (timeElapsed <= 0) return;

      const bytesSentSinceStart = bytesTransferredRef.current - speedLastBytesRef.current;
      const currentSpeed = bytesSentSinceStart / timeElapsed; // Bytes per sec

      const speedMB = currentSpeed / (1024 * 1024);
      setSpeed(Number(speedMB.toFixed(2)));

      // Estimate ETA
      if (fileInfo && currentSpeed > 0) {
        const remainingBytes = fileInfo.size - bytesTransferredRef.current;
        const remainingTime = Math.ceil(remainingBytes / currentSpeed);
        setEta(remainingTime);
      } else {
        setEta(0);
      }

      // Reset window for speed averages
      speedStartTimeRef.current = Date.now();
      speedLastBytesRef.current = bytesTransferredRef.current;
    }, 1000);
  };

  const stopSpeedTracker = () => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }
  };

  // Setup local peer connection object
  const createPeerConnection = (targetPeerId) => {
    addLog('Initializing RTCPeerConnection...', 'webrtc');
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('signal', {
          targetId: targetPeerId,
          signalData: { candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      addLog(`WebRTC Connection State: ${pc.connectionState}`, 'webrtc');
      
      switch (pc.connectionState) {
        case 'connected':
          setConnectionStatus('connected');
          setError(null);
          addLog('WebRTC Direct Data Connection Established!', 'success');
          break;
        case 'disconnected':
        case 'failed':
          setConnectionStatus('reconnecting');
          addLog('WebRTC Connection Dropped. Attempting auto-resume handshake...', 'warning');
          cleanupWebRTC();
          break;
        case 'closed':
          setConnectionStatus('disconnected');
          cleanupWebRTC();
          break;
      }
    };

    // If we are the receiver, the sender will create the data channel, so we listen for it
    pc.ondatachannel = (event) => {
      addLog('Discovered incoming WebRTC Data Channel.', 'webrtc');
      setupDataChannel(event.channel);
    };

    return pc;
  };

  // Sender creates the connection
  const initiateWebRTCConnection = async (targetPeerId) => {
    try {
      const pc = createPeerConnection(targetPeerId);
      
      addLog('Creating RTCDataChannel for transfer stream...', 'webrtc');
      // Create data channel with flow control configuration
      const channel = pc.createDataChannel('p2p-file-transfer', {
        ordered: true,
        negotiated: false
      });
      
      setupDataChannel(channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      addLog('Local offer generated. Sending to receiver peer...', 'webrtc');
      socketRef.current.emit('signal', {
        targetId: targetPeerId,
        signalData: { sdp: offer }
      });
    } catch (err) {
      addLog(`Failed to initiate WebRTC handshake: ${err.message}`, 'error');
      setError('Handshake failed.');
    }
  };

  // Setup common data channel events and messages
  const setupDataChannel = (channel) => {
    dataChannelRef.current = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      addLog('WebRTC Data Channel is OPEN.', 'webrtc');
      
      if (isSender) {
        // As a sender, we send the file metadata immediately
        sendFileMetadata();
      } else {
        // As a receiver, check if we have chunks stored for resume
        requestResumeState();
      }
    };

    channel.onclose = () => {
      addLog('WebRTC Data Channel closed.', 'webrtc');
      stopSpeedTracker();
      isTransferringRef.current = false;
    };

    channel.onerror = (err) => {
      addLog(`WebRTC Data Channel Error: ${err.message}`, 'error');
    };

    // Low-level buffer threshold to prevent browser memory overflow
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
    
    channel.onbufferedamountlow = () => {
      if (isBufferFullRef.current) {
        isBufferFullRef.current = false;
        addLog('Flow control: buffer drained below watermark. Resuming reader...', 'transfer');
        if (isTransferringRef.current) {
          sendNextChunks();
        }
      }
    };

    channel.onmessage = (event) => {
      handleChannelMessage(event.data);
    };
  };

  // Send File Metadata from Sender to Receiver
  const sendFileMetadata = () => {
    if (!fileRef.current || !dataChannelRef.current) return;

    addLog('Sending file metadata...', 'transfer');
    const metadata = {
      type: 'metadata',
      name: fileRef.current.name,
      size: fileRef.current.size,
      mimeType: fileRef.current.type,
      totalChunks: Math.ceil(fileRef.current.size / CHUNK_SIZE),
      hash: fileInfo.hash
    };

    dataChannelRef.current.send(JSON.stringify(metadata));
  };

  // Receiver requesting resume state on connect
  const requestResumeState = async () => {
    if (!roomId) return;
    const count = await getStoredChunkCount(roomId);
    addLog(`IndexedDB contains ${count} verified chunks. Requesting resumption info...`, 'transfer');
    
    const msg = {
      type: 'resume-request',
      lastReceivedIndex: count - 1
    };
    
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify(msg));
    }
  };

  // Handle incoming control or data messages
  const handleChannelMessage = async (data) => {
    if (typeof data === 'string') {
      // JSON Control message
      const msg = JSON.parse(data);
      
      if (msg.type === 'metadata') {
        addLog(`Received metadata: ${msg.name} (${(msg.size / (1024 * 1024)).toFixed(2)} MB)`, 'transfer');
        setFileInfo({
          name: msg.name,
          size: msg.size,
          mimeType: msg.mimeType,
          totalChunks: msg.totalChunks,
          hash: msg.hash
        });
        bytesTransferredRef.current = 0;
        setProgress(0);
        setTransferState('transferring');
        startSpeedTracker();
        
        // Prepare database for local chunks
        await clearChunks(roomId);
        addLog('Initialized local IndexedDB database store.', 'info');

        // Let the sender know we are ready from start
        dataChannelRef.current.send(JSON.stringify({
          type: 'resume-request',
          lastReceivedIndex: -1
        }));
      }
      
      else if (msg.type === 'resume-request') {
        const lastReceived = msg.lastReceivedIndex;
        lastAcknowledgedChunkRef.current = lastReceived;
        bytesTransferredRef.current = Math.min((lastReceived + 1) * CHUNK_SIZE, fileRef.current.size);
        
        addLog(`Peer requested transfer starting from chunk index ${lastReceived + 1}`, 'transfer');
        setTransferState('transferring');
        isTransferringRef.current = true;
        startSpeedTracker();
        sendNextChunks();
      }
      
      else if (msg.type === 'ack') {
        lastAcknowledgedChunkRef.current = msg.index;
        const total = fileRef.current.size;
        bytesTransferredRef.current = Math.min((msg.index + 1) * CHUNK_SIZE, total);
        const percent = Math.min(100, Math.round((bytesTransferredRef.current / total) * 100));
        setProgress(percent);

        if (percent >= 100) {
          setTransferState('completed');
          isTransferringRef.current = false;
          stopSpeedTracker();
          addLog('All file chunks acknowledged by receiver!', 'success');
        } else if (isTransferringRef.current) {
          sendNextChunks();
        }
      }

      else if (msg.type === 'pause') {
        isTransferringRef.current = false;
        setTransferState('paused');
        stopSpeedTracker();
        addLog('Transfer paused by peer.', 'warning');
      }

      else if (msg.type === 'resume') {
        isTransferringRef.current = true;
        setTransferState('transferring');
        startSpeedTracker();
        sendNextChunks();
        addLog('Transfer resumed by peer.', 'info');
      }

      else if (msg.type === 'error') {
        setError(msg.message);
        setTransferState('failed');
        addLog(`Transfer aborted: ${msg.message}`, 'error');
      }
    } 
    
    else if (data instanceof ArrayBuffer) {
      // Binary File Chunk Packet
      if (!keyRef.current) {
        addLog('Error: Decryption key is missing, cannot decrypt chunk.', 'error');
        return;
      }

      try {
        const dataView = new DataView(data);
        const chunkIndex = dataView.getUint32(0); // 4 bytes uint32
        
        // Extract 32-byte hash
        const expectedHashBytes = new Uint8Array(data, 4, 32);
        const expectedHashHex = bufferToHex(expectedHashBytes);

        // Extract 12-byte IV
        const iv = new Uint8Array(data, 36, 12);

        // Extract encrypted payload
        const encryptedPayload = data.slice(48);

        // Decrypt the payload
        const decryptedBuffer = await decryptChunk(keyRef.current, encryptedPayload, iv);

        // Verify SHA-256 chunk hash
        const actualHashHex = await computeSHA256(decryptedBuffer);

        if (expectedHashHex !== actualHashHex) {
          throw new Error(`Integrity check failed on chunk ${chunkIndex}. Expected: ${expectedHashHex}, Got: ${actualHashHex}`);
        }

        // Save decypted chunk in IndexedDB
        await saveChunk(roomId, chunkIndex, decryptedBuffer);
        
        // Update stats
        bytesTransferredRef.current = Math.min((chunkIndex + 1) * CHUNK_SIZE, fileInfo.size);
        const percent = Math.min(100, Math.round((bytesTransferredRef.current / fileInfo.size) * 100));
        setProgress(percent);

        // Send ACK back
        dataChannelRef.current.send(JSON.stringify({
          type: 'ack',
          index: chunkIndex
        }));

        if (percent >= 100) {
          setTransferState('completed');
          stopSpeedTracker();
          addLog(`All chunks received and decrypted. Initiating full file verification...`, 'crypto');
          await assembleAndDownloadFile();
        }
      } catch (err) {
        addLog(`Failed to process chunk: ${err.message}`, 'error');
        dataChannelRef.current.send(JSON.stringify({
          type: 'error',
          message: 'Decryption or integrity error'
        }));
        setTransferState('failed');
        setError(err.message);
      }
    }
  };

  // Sender: Stream chunks with flow control / backpressure check
  const sendNextChunks = async () => {
    if (!isTransferringRef.current || !dataChannelRef.current || !fileRef.current) return;

    const channel = dataChannelRef.current;
    
    // Check backpressure watermark
    if (channel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
      isBufferFullRef.current = true;
      addLog('Flow control: buffer high watermark hit. Throttling reader...', 'transfer');
      return;
    }

    const nextChunkIndex = lastAcknowledgedChunkRef.current + 1;
    const totalChunks = Math.ceil(fileRef.current.size / CHUNK_SIZE);

    if (nextChunkIndex >= totalChunks) {
      // Completed sending, wait for final ACK
      return;
    }

    try {
      const file = fileRef.current;
      const offset = nextChunkIndex * CHUNK_SIZE;
      const sizeToSend = Math.min(CHUNK_SIZE, file.size - offset);

      // Read chunk
      const fileSlice = file.slice(offset, offset + sizeToSend);
      const chunkBuffer = await fileSlice.arrayBuffer();

      // Compute plaintext hash
      const chunkHashBuffer = await window.crypto.subtle.digest('SHA-256', chunkBuffer);

      // Generate a new IV (12 bytes)
      const iv = window.crypto.getRandomValues(new Uint8Array(12));

      // Encrypt the chunk
      const encryptedPayload = await encryptChunk(keyRef.current, chunkBuffer, iv);

      // Assemble packet: 4 bytes (index) + 32 bytes (hash) + 12 bytes (IV) + encrypted payload
      const packet = new Uint8Array(48 + encryptedPayload.byteLength);
      
      // Write index (uint32 big endian)
      const dataView = new DataView(packet.buffer);
      dataView.setUint32(0, nextChunkIndex);

      // Write SHA-256 hash (32 bytes)
      packet.set(new Uint8Array(chunkHashBuffer), 4);

      // Write IV (12 bytes)
      packet.set(iv, 36);

      // Write Encrypted Payload
      packet.set(new Uint8Array(encryptedPayload), 48);

      // Send via data channel
      channel.send(packet.buffer);

      // Increment optimism but don't commit until ACKed
      lastAcknowledgedChunkRef.current = nextChunkIndex;

      // Immediately queue next chunk if the channel has buffer headroom
      if (channel.bufferedAmount <= BUFFER_HIGH_WATERMARK) {
        setTimeout(sendNextChunks, 0);
      }
    } catch (err) {
      addLog(`Failed to encrypt or send chunk: ${err.message}`, 'error');
      channel.send(JSON.stringify({
        type: 'error',
        message: 'Sender read error'
      }));
      setTransferState('failed');
      isTransferringRef.current = false;
    }
  };

  // Receiver: Assemble chunks from IndexedDB, verify full SHA-256, and trigger download
  const assembleAndDownloadFile = async () => {
    try {
      setTransferState('hashing');
      addLog('Reading chunks from IndexedDB and validating full integrity...', 'crypto');

      const chunks = await getAllChunks(roomId);
      
      if (chunks.length !== fileInfo.totalChunks) {
        throw new Error(`Database chunk count mismatch. Expected: ${fileInfo.totalChunks}, stored: ${chunks.length}`);
      }

      // Create single Blob to compute overall SHA-256
      const blob = new Blob(chunks, { type: fileInfo.mimeType || 'application/octet-stream' });
      const fullArrayBuffer = await blob.arrayBuffer();
      
      const fileHashHex = await computeSHA256(fullArrayBuffer);
      addLog(`Computed file hash: ${fileHashHex}`, 'crypto');
      addLog(`Expected file hash: ${fileInfo.hash}`, 'crypto');

      if (fileHashHex !== fileInfo.hash) {
        throw new Error('Integrity validation failed! The reassembled file does not match the sender\'s hash.');
      }

      addLog('Integrity check PASSED! Zero data corruption detected.', 'success');

      // Trigger Download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileInfo.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setTransferState('completed');
      addLog(`File successfully downloaded: ${fileInfo.name}`, 'success');
      
      // Clear database to free space
      await clearChunks(roomId);
      addLog('Freed IndexedDB space.', 'info');
    } catch (err) {
      addLog(`Reassembly/Verification failed: ${err.message}`, 'error');
      setTransferState('failed');
      setError(err.message);
    }
  };

  // SENDER: Drop zone handler, starts hashing and room creation
  const startFileShare = async (selectedFile) => {
    if (!selectedFile) return;
    
    fileRef.current = selectedFile;
    setIsSender(true);
    setTransferState('hashing');
    setError(null);
    setProgress(0);
    
    addLog(`Selected file: ${selectedFile.name} (${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)`, 'info');
    addLog('Generating 256-bit AES-GCM encryption key...', 'crypto');
    
    try {
      // Generate Cryptographic Key
      const key = await generateKey();
      keyRef.current = key;
      const keyHex = await exportKeyToHex(key);
      
      // Generate random room ID (8 bytes represented as hex)
      const generatedRoomId = bufferToHex(window.crypto.getRandomValues(new Uint8Array(8)));
      setRoomId(generatedRoomId);

      // Compute overall file SHA-256 hash
      addLog('Computing file SHA-256 hash to guarantee data integrity...', 'crypto');
      const fileBuffer = await selectedFile.arrayBuffer();
      const fileHash = await computeSHA256(fileBuffer);
      
      const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
      setFileInfo({
        name: selectedFile.name,
        size: selectedFile.size,
        mimeType: selectedFile.type,
        totalChunks,
        hash: fileHash
      });

      addLog(`File SHA-256 computed: ${fileHash}`, 'crypto');

      // Form room link with hash fragment key
      const origin = window.location.origin + window.location.pathname;
      const hashConfig = `room=${generatedRoomId}&key=${keyHex}`;
      const inviteUrl = `${origin}#${hashConfig}`;
      
      // Initialize Socket connection
      initSocket();
      socketRef.current.emit('join-room', generatedRoomId);
      addLog(`Creating and entering signaling room: ${generatedRoomId}`, 'signal');

      // Update URL hash without reload
      window.location.hash = hashConfig;

      setTransferState('idle');
    } catch (err) {
      addLog(`Error sharing file: ${err.message}`, 'error');
      setError(err.message);
      setTransferState('idle');
    }
  };

  // RECEIVER: Joins room from parsed URL params
  const startFileReceive = async (targetRoomId, keyHex) => {
    setIsSender(false);
    setRoomId(targetRoomId);
    setError(null);
    setProgress(0);
    setTransferState('idle');

    try {
      addLog(`Connecting to room ${targetRoomId} for receive stream...`, 'signal');
      addLog(`Importing AES-GCM decryption key from URL...`, 'crypto');
      
      const key = await importKeyFromHex(keyHex);
      keyRef.current = key;

      initSocket();
      socketRef.current.emit('join-room', targetRoomId);
    } catch (err) {
      addLog(`Failed to initialize receiver: ${err.message}`, 'error');
      setError('Decryption key parsing failed.');
    }
  };

  // Manual Pause/Resume controls
  const pauseTransfer = () => {
    if (!isTransferringRef.current) return;
    isTransferringRef.current = false;
    setTransferState('paused');
    stopSpeedTracker();
    addLog('Manually paused transfer. Signaling peer...', 'info');
    
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify({ type: 'pause' }));
    }
  };

  const resumeTransfer = () => {
    if (isTransferringRef.current) return;
    isTransferringRef.current = true;
    setTransferState('transferring');
    startSpeedTracker();
    addLog('Manually resuming transfer. Signaling peer...', 'info');

    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify({ type: 'resume' }));
      if (isSender) {
        sendNextChunks();
      }
    }
  };

  // Clean up socket on unmount
  useEffect(() => {
    return () => {
      cleanupWebRTC();
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  return {
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
  };
}
