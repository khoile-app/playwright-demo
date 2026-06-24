const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1 id="title">Hello Playwright</h1>
      </body>
    </html>
  `);
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});