const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Login Page</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          form { max-width: 280px; display: flex; flex-direction: column; gap: 12px; }
          label { font-weight: bold; }
          input { padding: 8px; }
          button {
            background-color: #28a745;
            color: white;
            border: none;
            padding: 10px 14px;
            cursor: pointer;
            border-radius: 4px;
          }
        </style>
      </head>
      <body>
        <h1 id="title">Hello Playwright</h1>
        <form action="/login" method="post">
          <label for="username">Username</label>
          <input id="username" name="username" type="text" />

          <label for="password">Password</label>
          <input id="password" name="password" type="password" />

          <button type="submit">Login</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const username = req.body.username || 'Guest';
  res.redirect(`/profile?username=${encodeURIComponent(username)}`);
});

app.get('/profile', (req, res) => {
  const username = req.query.username || 'Guest';

  res.send(`
    <html>
      <head>
        <title>Profile</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          img { max-width: 400px; margin-top: 16px; }
        </style>
      </head>
      <body>
        <h1 id="profile-title">Welcome, ${username}</h1>
        <img id="cat-image" src="https://cataas.com/cat?position=center" alt="Random cat" />
      </body>
    </html>
  `);
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});