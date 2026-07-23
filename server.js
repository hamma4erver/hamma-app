const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.GROQ_API_KEY;

app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "GROQ_API_KEY is missing on Render." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
        const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "user", content: prompt }
                ]
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

io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
