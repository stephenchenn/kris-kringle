const { app, db, transporter } = require('../../server');
const server = app.listen(0, '127.0.0.1', () => {
  process.env.BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.send({ baseUrl: process.env.BASE_URL });
});
process.once('SIGTERM', () => {
  server.close(() => { transporter.close(); db.close(); process.exit(0); });
  server.closeAllConnections();
});
