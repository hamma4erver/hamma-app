const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data); // يبعث الرسالة للناس الكل
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Hamma Server is live!'));