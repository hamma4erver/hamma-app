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
// تهيئة Firebase Admin SDK
// FIREBASE_SERVICE_ACCOUNT لازم يكون JSON كامل (نص واحد) فمتغيرات البيئة
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
// تتحقق من التوكن وترجع true/false إذا المستخدم admin أو moderator
// ==================================================
async function verifyAdmin(idToken) {
    if (!idToken || !db) return { ok: false };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        const role = userDoc.exists ? userDoc.data().role : null;
        const isOwner = decoded.name === "Hamma" || decoded.name === "Hamma Admin";
        const isAllowed = role === "admin" || role === "moderator" || isOwner;
        return { ok: isAllowed, uid: decoded.uid, name: decoded.name };
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { ok: false };
    }
}

// مسار الذكاء الاصطناعي
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

// إدارة الحظر والكتم
const mutedUsers = new Set();
const blockedUsers = new Set();
let onlineUsersCount = 0;

function broadcastStatusLists() {
    io.emit('status-lists', {
        muted: [...mutedUsers],
        banned: [...blockedUsers]
    });
}

io.on('connection', (socket) => {
    onlineUsersCount++;
    io.emit('update-online', onlineUsersCount);

    // نبعث الحالة الحالية للمستخدم الجديد فور ما يتصل
    socket.emit('status-lists', {
        muted: [...mutedUsers],
        banned: [...blockedUsers]
    });

    socket.on('chat-message', (data) => {
        if (blockedUsers.has(data.user)) {
            return socket.emit('system-msg', 'أنت محظور من إرسال الرسائل.');
        }
        if (mutedUsers.has(data.user)) {
            return socket.emit('system-msg', 'تم كتم صوتك، لا يمكنك الإرسال.');
        }
        io.emit('chat-message', data);
    });

    // 1. حذف رسالة
    socket.on('delete-message', async ({ msgId, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', 'ليست لديك صلاحية الحذف.');
        io.emit('delete-message', msgId);
    });

    // 2. كتم / إلغاء كتم
    socket.on('mute-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', 'ليست لديك صلاحية الكتم.');
        mutedUsers.add(username);
        io.emit('system-msg', `تم كتم: ${username}`);
        broadcastStatusLists();
    });

    socket.on('unmute-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', 'ليست لديك صلاحية الكتم.');
        mutedUsers.delete(username);
        io.emit('system-msg', `تم إلغاء كتم: ${username}`);
        broadcastStatusLists();
    });

    // 3. حظر / إلغاء حظر
    socket.on('block-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', 'ليست لديك صلاحية الحظر.');
        blockedUsers.add(username);
        io.emit('system-msg', `تم حظر: ${username}`);
        broadcastStatusLists();
    });

    socket.on('unblock-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', 'ليست لديك صلاحية الحظر.');
        blockedUsers.delete(username);
        io.emit('system-msg', `تم إلغاء حظر: ${username}`);
        broadcastStatusLists();
    });

    socket.on('disconnect', () => {
        onlineUsersCount = Math.max(0, onlineUsersCount - 1);
        io.emit('update-online', onlineUsersCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
