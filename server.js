const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // يسمح بالاتصال من أي مكان في العالم
});

// تشغيل الملفات الواجهة (الموقع)
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل بالسيرفر: ' + socket.id);

    // استقبال الرسالة من أي صديق
    socket.on('send_message', (data) => {
        // إرسال الرسالة فوراً لجميع المتصلين بالتطبيق
        io.emit('receive_message', data);
    });

    socket.on('disconnect', () => {
        console.log('غادر أحد المستخدمين');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر Hamma يعمل الآن على المنفذ ${PORT}`);
});
