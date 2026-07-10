function getUsername() {
    let user = localStorage.getItem('chat_username');
    if (!user) {
        user = prompt("أدخل اسمك للدخول إلى شات حمة:");
        if (!user) user = "مجهول";
        localStorage.setItem('chat_username', user);
    }
    return user;
}