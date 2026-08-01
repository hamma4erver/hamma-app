const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.GROQ_API_KEY;

// ==================================================
// Firebase Admin SDK initialization
// FIREBASE_SERVICE_ACCOUNT must be the full service account JSON (as one string) in env vars
// ==================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT is missing! Admin actions will fail.");
} else {
    admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        )
    });
}

const db = admin.apps.length ? admin.firestore() : null;

// ==================================================
// Verifies a Firebase ID token and checks if the user is admin/moderator
// ==================================================
async function verifyAdmin(idToken) {
    if (!idToken || !db) return { ok: false };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        const role = userDoc.exists ? userDoc.data().role : null;
        const ownerNames = ["hamma", "hamma admin", "othmani hiba"];
        const isOwner = decoded.name && ownerNames.includes(decoded.name.toLowerCase());
        const isAllowed = role === "admin" || role === "moderator" || isOwner;
        return { ok: isAllowed, uid: decoded.uid, name: decoded.name };
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { ok: false };
    }
}

// AI chat endpoint
app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    if (!apiKey) return res.json({ reply: "GROQ_API_KEY is missing on Render." });

    try {
        const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await apiResponse.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            res.json({ reply: data.choices[0].message.content });
        } else if (data.error) {
            res.json({ reply: `Groq Error: ${data.error.message}` });
        } else {
            res.json({ reply: "Received an invalid response structure." });
        }
    } catch (error) {
        res.json({ reply: `Fetch Error: ${error.message}` });
    }
});

// ==================================================
// Moderation state: timed mutes, permanent bans, chat lock, pinned message
// ==================================================
const mutedUsers = new Map();     // username -> expiresAt (timestamp ms)
const muteTimers = new Map();     // username -> setTimeout handle
const blockedUsers = new Set();   // username -> permanently banned
const socketUsers = new Map();    // socket.id -> username
let onlineUsersCount = 0;
let chatLocked = false;           // when true, only admins/mods can send messages
let pinnedMessage = null;         // { id, user, text } or null

function getStatusLists() {
    // Clean up any expired mutes before broadcasting
    const now = Date.now();
    for (const [user, expiresAt] of mutedUsers.entries()) {
        if (expiresAt <= now) mutedUsers.delete(user);
    }
    return {
        muted: [...mutedUsers.entries()].map(([username, expiresAt]) => ({ username, expiresAt })),
        banned: [...blockedUsers]
    };
}

function broadcastStatusLists() {
    io.emit('status-lists', getStatusLists());
}

function scheduleAutoUnmute(username, ms) {
    if (muteTimers.has(username)) clearTimeout(muteTimers.get(username));
    const timer = setTimeout(() => {
        mutedUsers.delete(username);
        muteTimers.delete(username);
        io.emit('system-msg', { text: `Mute expired for: ${username}`, kind: 'info' });
        broadcastStatusLists();
    }, ms);
    muteTimers.set(username, timer);
}

// Kicks every socket registered under this username (used on ban)
function kickUserSockets(username, reason) {
    for (const [socketId, uname] of socketUsers.entries()) {
        if (uname === username) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
                s.emit('you-are-banned', { reason });
                s.disconnect(true);
            }
            socketUsers.delete(socketId);
        }
    }
}

io.on('connection', (socket) => {
    onlineUsersCount++;
    io.emit('update-online', onlineUsersCount);

    // Send current state to the newly connected client
    socket.emit('status-lists', getStatusLists());
    socket.emit('chat-lock-status', { locked: chatLocked });
    socket.emit('pinned-message-update', pinnedMessage);

    // Client registers its username right after entering the chat,
    // so bans can be enforced immediately even for already-connected users
    socket.on('register-user', ({ username }) => {
        if (!username) return;
        if (blockedUsers.has(username)) {
            socket.emit('you-are-banned', { reason: 'You are banned from this chat.' });
            socket.disconnect(true);
            return;
        }
        socketUsers.set(socket.id, username);
    });

    socket.on('chat-message', async (data) => {
        if (blockedUsers.has(data.user)) {
            return socket.emit('system-msg', { text: 'You are banned from sending messages.', kind: 'error' });
        }
        const expiresAt = mutedUsers.get(data.user);
        if (expiresAt && expiresAt > Date.now()) {
            const remaining = Math.ceil((expiresAt - Date.now()) / 60000);
            return socket.emit('system-msg', { text: `You are muted, try again in ${remaining} minute(s).`, kind: 'error' });
        }
        if (chatLocked) {
            const { ok } = await verifyAdmin(data.idToken);
            if (!ok) {
                return socket.emit('system-msg', { text: 'Chat is currently locked by an admin.', kind: 'error' });
            }
        }
        io.emit('chat-message', data);
    });

    // Delete a message
    socket.on('delete-message', async ({ msgId, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to delete messages.', kind: 'error' });
        io.emit('delete-message', msgId);
    });

    // Timed mute (minutes: 5 / 15 / 30 / 60)
    socket.on('mute-user', async ({ username, idToken, minutes }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to mute users.', kind: 'error' });

        const allowedDurations = [5, 15, 30, 60];
        const duration = allowedDurations.includes(Number(minutes)) ? Number(minutes) : 5;
        const ms = duration * 60 * 1000;
        const expiresAt = Date.now() + ms;

        mutedUsers.set(username, expiresAt);
        scheduleAutoUnmute(username, ms);

        io.emit('system-msg', { text: `🔇 ${username} has been muted for ${duration} minute(s).`, kind: 'mute' });
        broadcastStatusLists();
    });

    socket.on('unmute-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unmute users.', kind: 'error' });

        mutedUsers.delete(username);
        if (muteTimers.has(username)) {
            clearTimeout(muteTimers.get(username));
            muteTimers.delete(username);
        }
        io.emit('system-msg', { text: `🔊 ${username} has been unmuted.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Permanent ban / unban
    socket.on('block-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to ban users.', kind: 'error' });

        blockedUsers.add(username);
        io.emit('system-msg', { text: `🚫 ${username} has been banned from the chat.`, kind: 'ban' });
        kickUserSockets(username, 'You have been banned by an admin.');
        broadcastStatusLists();
    });

    socket.on('unblock-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unban users.', kind: 'error' });

        blockedUsers.delete(username);
        io.emit('system-msg', { text: `✅ ${username} has been unbanned.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Clear the entire chat for everyone
    socket.on('clear-chat', async ({ idToken }) => {
        const { ok, name } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to clear the chat.', kind: 'error' });

        pinnedMessage = null;
        io.emit('chat-cleared', { by: name || 'Admin' });
        io.emit('pinned-message-update', null);
    });

    // Lock / unlock the chat (only admins/mods can send while locked)
    socket.on('lock-chat', async ({ idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to lock the chat.', kind: 'error' });
        chatLocked = true;
        io.emit('chat-lock-status', { locked: true });
        io.emit('system-msg', { text: '🔒 The chat has been locked by an admin.', kind: 'ban' });
    });

    socket.on('unlock-chat', async ({ idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unlock the chat.', kind: 'error' });
        chatLocked = false;
        io.emit('chat-lock-status', { locked: false });
        io.emit('system-msg', { text: '🔓 The chat has been unlocked.', kind: 'info' });
    });

    // Pin / unpin a message (the server has no message history, so the client sends the content)
    socket.on('pin-message', async ({ msgId, user, text, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to pin messages.', kind: 'error' });

        pinnedMessage = { id: msgId, user, text };
        io.emit('pinned-message-update', pinnedMessage);
    });

    socket.on('unpin-message', async ({ idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unpin messages.', kind: 'error' });

        pinnedMessage = null;
        io.emit('pinned-message-update', null);
    });

    socket.on('disconnect', () => {
        socketUsers.delete(socket.id);
        onlineUsersCount = Math.max(0, onlineUsersCount - 1);
        io.emit('update-online', onlineUsersCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
