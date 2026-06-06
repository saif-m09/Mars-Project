// Web Crypto API Helpers for Zero-Knowledge P2P File Sharing

// Helper to convert ArrayBuffer to Hex string
export function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper to convert Hex string to ArrayBuffer
export function hexToBuffer(hexString) {
  if (hexString.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

// Generate a new AES-GCM 256-bit key
export async function generateKey() {
  return await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );
}

// Export Key to Hex String
export async function exportKeyToHex(key) {
  const rawKey = await window.crypto.subtle.exportKey('raw', key);
  return bufferToHex(rawKey);
}

// Import Key from Hex String
export async function importKeyFromHex(hexKey) {
  const rawKey = hexToBuffer(hexKey);
  return await window.crypto.subtle.importKey(
    'raw',
    rawKey,
    {
      name: 'AES-GCM'
    },
    true,
    ['encrypt', 'decrypt']
  );
}

// Encrypt a single chunk of data (ArrayBuffer) using AES-GCM
export async function encryptChunk(key, data, iv) {
  // data should be ArrayBuffer
  // iv should be a Uint8Array of size 12
  return await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    data
  );
}

// Decrypt a single chunk of data (ArrayBuffer) using AES-GCM
export async function decryptChunk(key, encryptedData, iv) {
  // encryptedData should be ArrayBuffer
  // iv should be Uint8Array of size 12
  return await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    encryptedData
  );
}

// Compute SHA-256 hash of an ArrayBuffer
export async function computeSHA256(dataBuffer) {
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', dataBuffer);
  return bufferToHex(hashBuffer);
}
