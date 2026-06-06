const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins for development ease
    methods: ['GET', 'POST']
  }
});

// Track active rooms and their client IDs
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Signaling] Client connected: ${socket.id}`);

  // Join a sharing room
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    
    const peersInRoom = rooms.get(roomId);
    
    // Tell the joining peer about existing peers in the room
    const existingPeers = Array.from(peersInRoom);
    socket.emit('room-peers', existingPeers);
    
    // Add the new peer to our tracking
    peersInRoom.add(socket.id);
    
    // Notify existing peers that a new peer has joined
    socket.to(roomId).emit('peer-joined', socket.id);
    
    console.log(`[Signaling] Peer ${socket.id} joined room ${roomId}. Peers in room: ${peersInRoom.size}`);

    socket.on('disconnect', () => {
      console.log(`[Signaling] Client disconnected from room: ${socket.id}`);
      
      const peers = rooms.get(roomId);
      if (peers) {
        peers.delete(socket.id);
        if (peers.size === 0) {
          rooms.delete(roomId);
          console.log(`[Signaling] Room ${roomId} is now empty and has been removed.`);
        } else {
          // Notify other peers in the room about the departure
          socket.to(roomId).emit('peer-left', socket.id);
        }
      }
    });
  });

  // Relay WebRTC signaling data (offer, answer, candidate) to a specific target peer
  socket.on('signal', ({ targetId, signalData }) => {
    // Relay the signal, attaching the sender's ID so the target knows who sent it
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`  P2P Web Share Signaling Server Running on Port ${PORT}`);
  console.log(`===================================================`);
});
