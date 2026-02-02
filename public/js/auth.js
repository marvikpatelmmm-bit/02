const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const toggleBtn = document.getElementById('toggleAuth');
const errorDiv = document.getElementById('authError');

let isLogin = true;

toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    isLogin = !isLogin;
    if (isLogin) {
        loginForm.style.display = 'block';
        registerForm.style.display = 'none';
        toggleBtn.textContent = 'Create an account';
    } else {
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
        toggleBtn.textContent = 'Already have an account? Login';
    }
    errorDiv.style.display = 'none';
});

async function handleAuth(endpoint, body) {
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        
        if (data.success) {
            window.location.href = '/dashboard';
        } else {
            errorDiv.textContent = data.error;
            errorDiv.style.display = 'block';
        }
    } catch (err) {
        errorDiv.textContent = 'Connection failed';
        errorDiv.style.display = 'block';
    }
}

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    handleAuth('/api/login', { username, password });
});

registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('regName').value;
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    handleAuth('/api/register', { name, username, password });
});