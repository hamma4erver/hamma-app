const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.GEMINI_API_KEY;

// مسار الـ AI مع الـ Fetch المباشر للـ Gemini API (يتعامل مع أي نوع مفتاح)
app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "API Key is missing on Render environment variables." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
        // استدعاء موديل gemini-1.5-flash مباشرة عبر الـ REST API الرسمي
        const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }]
            })
        });

        const data = await apiResponse.json();
        
        if (data.candidates && data.candidates[0].content.parts[0].text) {
            res.json({ reply: data.candidates[0].content.parts[0].text });
        } else {
            console.error("API Error Structure:", data);
            res.json({ reply: "Sorry, received an invalid response from the AI server." });
        }
    } catch (error) {
        console.error("Fetch Error:", error);
        res.json({ reply: "Sorry, an error occurred while connecting to Gemini." });
    }
});

// إعدادات الـ Socket.io للشات العام
io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
