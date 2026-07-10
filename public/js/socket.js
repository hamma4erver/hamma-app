// ربط الإتصال مع السيرفر
const socket = io();

// دالة لإرسال الميساج عبر السيرفر
function sendMessageToServer(username, message) {
    socket.emit('send_message', { username, message });
}

// استقبال الميساج القادم من السيرفر وتوجيهه للـ UI
socket.on('receive_message', (data) => {
    displayNewMessage(data.username, data.message);
});