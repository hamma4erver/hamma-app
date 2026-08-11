const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

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
// Email verification (6-digit codes)
// Requires SMTP env vars: EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS
// (e.g. a Gmail App Password, or a service like Resend/Brevo/Mailgun SMTP)
// ==================================================
let mailer = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    mailer = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: Number(process.env.EMAIL_PORT) === 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
} else {
    console.warn("⚠️ Email SMTP env vars are missing! Verification emails will not be sent.");
}

const verificationCodes = new Map(); // email -> { code, expiresAt }

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/api/send-verification-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!mailer) return res.status(500).json({ success: false, message: 'Email service is not configured on the server.' });

    const code = generateCode();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    verificationCodes.set(email, { code, expiresAt });

    try {
        await mailer.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: email,
            subject: 'Your Hamma Chat verification code',
            text: `Your verification code is: ${code}\nIt expires in 10 minutes.`,
            html: `<p>Your verification code is:</p><h2 style="letter-spacing:6px;">${code}</h2><p>It expires in 10 minutes.</p>`
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Failed to send verification email:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send verification email.' });
    }
});

app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Email and code are required.' });

    const entry = verificationCodes.get(email);
    if (!entry) return res.status(400).json({ success: false, message: 'No code was sent to this email, or it already expired.' });
    if (Date.now() > entry.expiresAt) {
        verificationCodes.delete(email);
        return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }
    if (entry.code !== String(code).trim()) {
        return res.status(400).json({ success: false, message: 'Incorrect code.' });
    }

    verificationCodes.delete(email);

    // Mark the Firebase account as verified, if it exists
    try {
        if (db) {
            const userRecord = await admin.auth().getUserByEmail(email);
            await admin.auth().updateUser(userRecord.uid, { emailVerified: true });
        }
    } catch (e) {
        console.warn("Could not mark Firebase user as verified:", e.message);
    }

    res.json({ success: true });
});

// ==================================================
// Verifies a Firebase ID token and returns the caller's effective role.
// role is one of: "admin", "moderator", or null (regular user / invalid token)
// The owner accounts are always treated as "admin".
// ==================================================
const OWNER_NAMES = ["hamma", "hamma admin", "othmani hiba"];

async function verifyRole(idToken) {
    if (!idToken || !db) return { ok: false, role: null };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        const dbRole = userDoc.exists ? userDoc.data().role : null;
        const isOwner = decoded.name && OWNER_NAMES.includes(decoded.name.toLowerCase());

        let role = null;
        if (isOwner || dbRole === "admin") role = "admin";
        else if (dbRole === "moderator") role = "moderator";

        return { ok: role !== null, role, uid: decoded.uid, name: decoded.name, isOwner };
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { ok: false, role: null };
    }
}

// Backwards-compatible helper: true if the caller is admin OR moderator
async function verifyAdmin(idToken) {
    const { ok, role, uid, name } = await verifyRole(idToken);
    return { ok, role, uid, name };
}

// Looks up the role of a chat username (by Firestore `username`/`displayName` field),
// so staff-protection rules (e.g. "admins can't ban other admins") can be enforced
// even though the chat itself only knows people by their display name.
async function getRoleByUsername(username) {
    if (!username) return null;
    if (OWNER_NAMES.includes(username.toLowerCase())) return "admin";
    if (!db) return null;
    try {
        let snap = await db.collection('users').where('username', '==', username).limit(1).get();
        if (snap.empty) snap = await db.collection('users').where('displayName', '==', username).limit(1).get();
        if (snap.empty) return null;
        const role = snap.docs[0].data().role;
        return role === "admin" ? "admin" : (role === "moderator" ? "moderator" : "user");
    } catch (e) {
        console.error("Role lookup failed:", e.message);
        return null;
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
const modClearCooldowns = new Map(); // uid -> next-allowed-timestamp (ms) for moderators clearing chat
const CLEAR_COOLDOWN_MS = 5 * 60 * 1000;

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

function performChatClear(by) {
    pinnedMessage = null;
    io.emit('chat-cleared', { by: by || 'Admin' });
    io.emit('pinned-message-update', null);
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

    // Fired when a logged-in user changes their username from the profile panel.
    // Without this, renaming was an easy way to escape an active mute/ban
    // (the moderation state is keyed by username), so we carry the
    // mute/ban status over from the old name to the new one.
    socket.on('rename-user', async ({ oldUsername, newUsername, idToken }) => {
        if (!oldUsername || !newUsername || oldUsername === newUsername) return;
        try {
            if (!idToken || !db) return; // require a logged-in user
            await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return; // invalid token, ignore silently
        }

        if (blockedUsers.has(oldUsername)) {
            blockedUsers.delete(oldUsername);
            blockedUsers.add(newUsername);
        }

        if (mutedUsers.has(oldUsername)) {
            const expiresAt = mutedUsers.get(oldUsername);
            mutedUsers.delete(oldUsername);
            mutedUsers.set(newUsername, expiresAt);
            const remainingMs = expiresAt - Date.now();
            if (remainingMs > 0) scheduleAutoUnmute(newUsername, remainingMs);
        }

        socketUsers.set(socket.id, newUsername);
        broadcastStatusLists();

        if (blockedUsers.has(newUsername)) {
            kickUserSockets(newUsername, 'You have been banned by an admin.');
        }
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

    // Relay typing status to everyone else (Instagram-style "X is typing…" indicator)
    socket.on('typing', ({ username }) => {
        if (!username) return;
        socket.broadcast.emit('user-typing', { username });
    });

    socket.on('stop-typing', ({ username }) => {
        if (!username) return;
        socket.broadcast.emit('user-stop-typing', { username });
    });

    // Delete a message — the message's own sender can delete it, and so can
    // an admin or moderator (same staff tier that can already mute/pin).
    // Regular viewers are only told a message was "deleted by an admin" when staff did it
    // (never which admin/moderator), so the client can tell that apart from a self-delete.
    // Exception: only Hamma admin / Othmani Hiba (the owners) can delete another admin's message —
    // a regular admin/moderator can't touch what an admin wrote.
    socket.on('delete-message', async ({ msgId, idToken, messageSender }) => {
        const { role, name, isOwner } = await verifyRole(idToken);
        const isStaff = role === 'admin' || role === 'moderator';
        const isSelf = !!messageSender && !!name && messageSender.toLowerCase() === name.toLowerCase();

        if (!isSelf && !isStaff) {
            return socket.emit('system-msg', { text: 'You are not allowed to delete this message.', kind: 'error' });
        }

        if (!isSelf && isStaff && !isOwner) {
            const senderRole = await getRoleByUsername(messageSender);
            if (senderRole === 'admin') {
                return socket.emit('system-msg', { text: `🚫 Only Hamma Admin / Othmani Hiba can delete an admin's message.`, kind: 'error' });
            }
        }

        io.emit('delete-message', { msgId, staffDeleted: isStaff && !isSelf });
    });

    // Timed mute (minutes: 5 / 15 / 30 / 60) — admins AND moderators are allowed
    socket.on('mute-user', async ({ username, idToken, minutes }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to mute users.', kind: 'error' });

        const allowedDurations = [5, 15, 30, 60];
        const duration = allowedDurations.includes(Number(minutes)) ? Number(minutes) : 5;
        const ms = duration * 60 * 1000;
        const expiresAt = Date.now() + ms;

        // 😂 A moderator trying to mute an admin gets muted themselves instead
        let target = username;
        let backfired = false;
        if (role === 'moderator') {
            const targetRole = await getRoleByUsername(username);
            if (targetRole === 'admin') {
                target = name;
                backfired = true;
            }
        }

        mutedUsers.set(target, expiresAt);
        scheduleAutoUnmute(target, ms);

        if (backfired) {
            io.emit('system-msg', { text: `😂 ${name} tried to mute an admin... and got muted instead for ${duration} minute(s)!`, kind: 'mute' });
        } else {
            io.emit('system-msg', { text: `🔇 ${target} has been muted for ${duration} minute(s).`, kind: 'mute' });
        }
        broadcastStatusLists();
    });

    // Unmuting a moderator is reserved for the owners (Hamma Admin / Othmani Hiba) —
    // a regular admin can't lift a moderator's mute.
    socket.on('unmute-user', async ({ username, idToken }) => {
        const { ok, isOwner } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unmute users.', kind: 'error' });

        if (!isOwner) {
            const targetRole = await getRoleByUsername(username);
            if (targetRole === 'moderator') {
                return socket.emit('system-msg', { text: `🚫 Only Hamma Admin / Othmani Hiba can unmute a moderator.`, kind: 'error' });
            }
        }

        mutedUsers.delete(username);
        if (muteTimers.has(username)) {
            clearTimeout(muteTimers.get(username));
            muteTimers.delete(username);
        }
        io.emit('system-msg', { text: `🔊 ${username} has been unmuted.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Permanent ban (admins only — moderators can only mute/pin)
    socket.on('block-user', async ({ username, idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to ban users.', kind: 'error' });

        // Admins can't ban other admins — only mute them
        const targetRole = await getRoleByUsername(username);
        if (targetRole === 'admin') {
            return socket.emit('system-msg', { text: `🚫 Admins can't ban other admins. You can only mute ${username}.`, kind: 'error' });
        }

        blockedUsers.add(username);
        io.emit('system-msg', { text: `🚫 ${username} has been banned from the chat.`, kind: 'ban' });
        kickUserSockets(username, 'You have been banned by an admin.');
        broadcastStatusLists();
    });

    socket.on('unblock-user', async ({ username, idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to unban users.', kind: 'error' });

        blockedUsers.delete(username);
        io.emit('system-msg', { text: `✅ ${username} has been unbanned.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Clear the entire chat for everyone.
    // Admins can do this anytime. Moderators can too, but only once every 5 minutes.
    socket.on('clear-chat', async ({ idToken }) => {
        const { ok, role, name, uid } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to clear the chat.', kind: 'error' });

        if (role === 'admin') {
            performChatClear(name || 'Admin');
            socket.emit('clear-chat-result', { ok: true, nextAllowedAt: null });
            return;
        }

        // role === 'moderator'
        const now = Date.now();
        const nextAllowed = modClearCooldowns.get(uid) || 0;
        if (now < nextAllowed) {
            socket.emit('clear-chat-result', { ok: false, nextAllowedAt: nextAllowed });
            const remainingMin = Math.ceil((nextAllowed - now) / 60000);
            socket.emit('system-msg', { text: `⏳ You can clear the chat again in ~${remainingMin} minute(s).`, kind: 'error' });
            return;
        }

        modClearCooldowns.set(uid, now + CLEAR_COOLDOWN_MS);
        performChatClear(name || 'Moderator');
        socket.emit('clear-chat-result', { ok: true, nextAllowedAt: now + CLEAR_COOLDOWN_MS });
    });

    // Lets a moderator (or admin) find out their current clear-chat cooldown,
    // e.g. right after connecting/refreshing, so the button can show a live countdown.
    socket.on('get-clear-cooldown', async ({ idToken }) => {
        const { ok, role, uid } = await verifyRole(idToken);
        if (!ok) return;
        if (role === 'admin') return socket.emit('clear-cooldown-status', { nextAllowedAt: null });
        if (role === 'moderator') {
            const nextAllowed = modClearCooldowns.get(uid) || 0;
            return socket.emit('clear-cooldown-status', { nextAllowedAt: nextAllowed > Date.now() ? nextAllowed : null });
        }
    });

    // Lock / unlock the chat (admins only; while locked, only admins/mods can send)
    socket.on('lock-chat', async ({ idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to lock the chat.', kind: 'error' });
        chatLocked = true;
        io.emit('chat-lock-status', { locked: true });
        io.emit('system-msg', { text: '🔒 The chat has been locked by an admin.', kind: 'ban' });
    });

    socket.on('unlock-chat', async ({ idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to unlock the chat.', kind: 'error' });
        chatLocked = false;
        io.emit('chat-lock-status', { locked: false });
        io.emit('system-msg', { text: '🔓 The chat has been unlocked.', kind: 'info' });
    });

    // Pin / unpin a message — admins AND moderators are allowed
    socket.on('pin-message', async ({ msgId, user, text, idToken }) => {
        const { ok } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to pin messages.', kind: 'error' });

        pinnedMessage = { id: msgId, user, text };
        io.emit('pinned-message-update', pinnedMessage);
    });

    socket.on('unpin-message', async ({ idToken }) => {
        const { ok } = await verifyRole(idToken);
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
