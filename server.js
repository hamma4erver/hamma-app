const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.HF_API_KEY; 

app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "HF_API_KEY is missing on Render environment variables." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
        // استخدام رابط الـ Router الجديد والمستقر مع موديل Mistral السريع
        const apiResponse = await fetch("https://router.huggingface.co/hf-inference/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "mistralai/Mistral-7B-Instruct-v0.3",
                messages: [
                    { role: "user", content: prompt }
                ],
                max_tokens: 500
            })
        });

        const data = await apiResponse.json();
        
        if (data.error) {
            console.error("HF Error:", data.error);
            return res.json({ reply: `HF Error: ${typeof data.error === 'object' ? JSON.stringify(data.error) : data.error}` });
        }

        if (data.choices && data.choices[0] && data.choices[0].message) {
            res.json({ reply: data.choices[0].message.content });
        } else {
            console.error("HF Unknown Response:", data);
            res.json({ reply: "Sorry, received an invalid response structure." });
        }
    } catch (error) {
        console.error("Fetch Error:", error);
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
