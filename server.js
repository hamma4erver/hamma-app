const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.GEMINI_API_KEY;

app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "API Key is missing on Render environment variables." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
        // تعديل الـ URL والـ Headers لتقبل مفاتيح الـ Cloud والـ Studio بدون مشاكل
        const apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey // تمرير المفتاح في الـ Header لضمان عمل الـ Tokens المشفرة
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }]
            })
        });

        const data = await apiResponse.json();
        
        // التحقق من الإجابة واستخراج النص
        if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text) {
            res.json({ reply: data.candidates[0].content.parts[0].text });
        } else if (data.error) {
            console.error("Google API Error Details:", data.error);
            res.json({ reply: `API Error: ${data.error.message}` });
        } else {
            console.error("Unknown API Response Structure:", data);
            res.json({ reply: "Sorry, received an unreadable response from the AI." });
        }
    } catch (error) {
        console.error("Fetch Error:", error);
        res.json({ reply: "Sorry, an error occurred while connecting to the backend." });
    }
});

io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
